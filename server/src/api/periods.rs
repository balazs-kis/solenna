//! Periods (bleeding days) with a flow level per day.
//!
//! A period is saved as a whole: `POST` creates one, `PUT` replaces its days and
//! flow levels, `DELETE` removes it with its flow. That keeps every write a
//! single validated transaction, and the client never has to sync parts.
//! Predictions are computed in the browser from this data.

use std::collections::{BTreeMap, HashSet};

use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode,
};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    api::{day_number, is_future_day, is_valid_day, today_number},
    auth::CurrentUser,
    db::unix_now,
    error::AppError,
};

/// The longest bleeding we accept as one period. Also bounds the flow days
/// of an ongoing period (start + 14).
const MAX_PERIOD_DAYS: i64 = 15;
/// Stands in for "no end" when comparing ranges; sorts after every real day.
const OPEN_END: &str = "9999-12-31";

#[derive(Serialize)]
pub struct Period {
    id: i64,
    start_day: String,
    end_day: Option<String>,
    flow: Vec<FlowDay>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FlowDay {
    day: String,
    flow: i64,
}

#[derive(Deserialize)]
pub struct PeriodBody {
    start_day: String,
    end_day: Option<String>,
    #[serde(default)]
    flow: Vec<FlowDay>,
}

/// All periods of the user, oldest first, each with its flow days.
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<Period>>, AppError> {
    let periods = state
        .db
        .call(move |conn| Ok(all_periods(conn, user.id)?))
        .await?;
    Ok(Json(periods))
}

/// All periods of a user, oldest first. Also used by the data export.
pub fn all_periods(conn: &Connection, user_id: i64) -> rusqlite::Result<Vec<Period>> {
    let mut flows: BTreeMap<i64, Vec<FlowDay>> = BTreeMap::new();
    let mut statement = conn.prepare(
        "SELECT f.period_id, f.day, f.flow FROM period_flow f
         JOIN periods p ON p.id = f.period_id
         WHERE p.user_id = ? ORDER BY f.day",
    )?;
    let rows = statement.query_map([user_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            FlowDay {
                day: row.get(1)?,
                flow: row.get(2)?,
            },
        ))
    })?;
    for row in rows {
        let (period_id, flow) = row?;
        flows.entry(period_id).or_default().push(flow);
    }

    let mut statement = conn.prepare(
        "SELECT id, start_day, end_day FROM periods WHERE user_id = ? ORDER BY start_day",
    )?;
    let rows = statement.query_map([user_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    let mut periods = Vec::new();
    for row in rows {
        let (id, start_day, end_day) = row?;
        periods.push(Period {
            id,
            start_day,
            end_day,
            flow: flows.remove(&id).unwrap_or_default(),
        });
    }
    Ok(periods)
}

pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Result<Json<PeriodBody>, JsonRejection>,
) -> Result<(StatusCode, Json<Period>), AppError> {
    let body = validated(body)?;
    let period = state
        .db
        .call(move |conn| {
            let tx = conn.transaction()?;
            check_no_overlap(&tx, user.id, None, &body)?;
            let now = unix_now();
            let id: i64 = tx.query_row(
                "INSERT INTO periods (user_id, start_day, end_day, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4) RETURNING id",
                (user.id, &body.start_day, &body.end_day, now),
                |row| row.get(0),
            )?;
            insert_flow(&tx, id, &body.flow)?;
            tx.commit()?;
            Ok(into_period(id, body))
        })
        .await?;
    Ok((StatusCode::CREATED, Json(period)))
}

/// Replaces the period's days and flow levels.
pub async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
    body: Result<Json<PeriodBody>, JsonRejection>,
) -> Result<Json<Period>, AppError> {
    let body = validated(body)?;
    let period = state
        .db
        .call(move |conn| {
            let tx = conn.transaction()?;
            check_no_overlap(&tx, user.id, Some(id), &body)?;
            let updated = tx.execute(
                "UPDATE periods SET start_day = ?, end_day = ?, updated_at = ?
                 WHERE id = ? AND user_id = ?",
                (&body.start_day, &body.end_day, unix_now(), id, user.id),
            )?;
            if updated == 0 {
                return Err(AppError::NotFound);
            }
            // The period belongs to this user (checked just above).
            tx.execute("DELETE FROM period_flow WHERE period_id = ?", [id])?;
            insert_flow(&tx, id, &body.flow)?;
            tx.commit()?;
            Ok(into_period(id, body))
        })
        .await?;
    Ok(Json(period))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = state
        .db
        .call(move |conn| {
            Ok(conn.execute(
                "DELETE FROM periods WHERE id = ? AND user_id = ?",
                (id, user.id),
            )?)
        })
        .await?;
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Checks the body on its own: real days, a sane range, and flow days inside it.
fn validated(body: Result<Json<PeriodBody>, JsonRejection>) -> Result<PeriodBody, AppError> {
    let Json(mut body) = body.map_err(|_| AppError::BadRequest("invalid_body"))?;

    if !is_valid_day(&body.start_day) || !body.end_day.as_deref().is_none_or(is_valid_day) {
        return Err(AppError::BadRequest("invalid_day"));
    }
    let start = day_number(&body.start_day);
    let last_day = match &body.end_day {
        Some(end) => day_number(end),
        None => start + MAX_PERIOD_DAYS - 1,
    };
    if last_day < start || last_day - start >= MAX_PERIOD_DAYS {
        return Err(AppError::BadRequest("invalid_range"));
    }

    let mut seen = HashSet::new();
    for flow in &body.flow {
        let in_range =
            is_valid_day(&flow.day) && (start..=last_day).contains(&day_number(&flow.day));
        if !in_range || !(1..=5).contains(&flow.flow) || !seen.insert(flow.day.clone()) {
            return Err(AppError::BadRequest("invalid_flow"));
        }
    }

    // Nothing can be logged for a day that hasn't started anywhere yet.
    let future = is_future_day(&body.start_day)
        || body.end_day.as_deref().is_some_and(is_future_day)
        || body.flow.iter().any(|flow| is_future_day(&flow.day));
    if future {
        return Err(AppError::BadRequest("future_day"));
    }

    // An ongoing period that started longer ago than the longest period must
    // have ended by now. One extra day of slack covers the user's time zone.
    if body.end_day.is_none() && start < today_number() - MAX_PERIOD_DAYS {
        return Err(AppError::BadRequest("stale_ongoing"));
    }

    body.flow.sort_by(|a, b| a.day.cmp(&b.day));
    Ok(body)
}

/// Periods of one user never overlap; an ongoing period (no end) is open-ended.
fn check_no_overlap(
    conn: &Connection,
    user_id: i64,
    except_id: Option<i64>,
    body: &PeriodBody,
) -> Result<(), AppError> {
    let end = body.end_day.as_deref().unwrap_or(OPEN_END);
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM periods
             WHERE user_id = ?1 AND id != ?2
               AND start_day <= ?4 AND COALESCE(end_day, ?5) >= ?3
             LIMIT 1",
            (
                user_id,
                except_id.unwrap_or(0),
                &body.start_day,
                end,
                OPEN_END,
            ),
            |row| row.get(0),
        )
        .optional()?;
    match clash {
        Some(_) => Err(AppError::Conflict("overlapping_period")),
        None => Ok(()),
    }
}

fn insert_flow(conn: &Connection, period_id: i64, flow: &[FlowDay]) -> Result<(), AppError> {
    let mut statement =
        conn.prepare("INSERT INTO period_flow (period_id, day, flow) VALUES (?, ?, ?)")?;
    for day in flow {
        statement.execute((period_id, &day.day, day.flow))?;
    }
    Ok(())
}

fn into_period(id: i64, body: PeriodBody) -> Period {
    Period {
        id,
        start_day: body.start_day,
        end_day: body.end_day,
        flow: body.flow,
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use crate::{
        api::{day_string, today_number},
        auth::test_session,
        router, test_state,
    };

    /// The day `offset` days from today, for tests with ongoing periods (those
    /// must have started recently).
    fn d(offset: i64) -> String {
        day_string(today_number() + offset)
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        cookie: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, cookie)
            .body(body.map_or(Body::empty(), |b| Body::from(b.to_string())))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn app_with_users() -> (Router, String, String) {
        let state = test_state();
        let alice = test_session(&state, "sub-a", "alice@example.com").await;
        let bob = test_session(&state, "sub-b", "bob@example.com").await;
        (router(state), alice, bob)
    }

    /// Creates a period and returns its id.
    async fn create(app: &Router, cookie: &str, body: Value) -> i64 {
        let (status, period) = call(app, "POST", "/api/periods", cookie, Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{period}");
        period["id"].as_i64().unwrap()
    }

    #[tokio::test]
    async fn creates_updates_lists_and_deletes_periods() {
        let (app, alice, _) = app_with_users().await;

        // Started 4 days ago, still ongoing.
        let (start, end) = (d(-4), d(-1));
        let id = create(&app, &alice, json!({ "start_day": start, "end_day": null })).await;
        // Later: ended, with flow levels (sent unsorted).
        let (status, period) = call(
            &app,
            "PUT",
            &format!("/api/periods/{id}"),
            &alice,
            Some(json!({
                "start_day": start,
                "end_day": end,
                "flow": [{ "day": d(-3), "flow": 4 }, { "day": start, "flow": 3 }],
            })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(period["flow"][0]["day"], start);

        let (earlier_start, earlier_end) = (d(-40), d(-36));
        create(
            &app,
            &alice,
            json!({ "start_day": earlier_start, "end_day": earlier_end }),
        )
        .await;

        let (_, list) = call(&app, "GET", "/api/periods", &alice, None).await;
        assert_eq!(
            list,
            json!([
                { "id": list[0]["id"], "start_day": earlier_start, "end_day": earlier_end, "flow": [] },
                {
                    "id": id, "start_day": start, "end_day": end,
                    "flow": [{ "day": start, "flow": 3 }, { "day": d(-3), "flow": 4 }],
                },
            ])
        );

        let (status, _) = call(&app, "DELETE", &format!("/api/periods/{id}"), &alice, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, list) = call(&app, "GET", "/api/periods", &alice, None).await;
        assert_eq!(list.as_array().unwrap().len(), 1);
        let (status, _) = call(&app, "DELETE", &format!("/api/periods/{id}"), &alice, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn updating_replaces_the_flow_days() {
        let (app, alice, _) = app_with_users().await;
        let id = create(
            &app,
            &alice,
            json!({
                "start_day": "2026-10-01", "end_day": "2026-10-04",
                "flow": [{ "day": "2026-10-01", "flow": 2 }, { "day": "2026-10-04", "flow": 1 }],
            }),
        )
        .await;
        // Shortened to three days; the client sends the flow that still applies.
        call(
            &app,
            "PUT",
            &format!("/api/periods/{id}"),
            &alice,
            Some(json!({
                "start_day": "2026-10-01", "end_day": "2026-10-03",
                "flow": [{ "day": "2026-10-01", "flow": 3 }],
            })),
        )
        .await;
        let (_, list) = call(&app, "GET", "/api/periods", &alice, None).await;
        assert_eq!(list[0]["flow"], json!([{ "day": "2026-10-01", "flow": 3 }]));
    }

    #[tokio::test]
    async fn rejects_invalid_periods() {
        let (app, alice, _) = app_with_users().await;
        let cases = [
            (json!({ "start_day": "2026-02-30" }), "invalid_day"),
            (
                json!({ "start_day": "2026-10-01", "end_day": "soon" }),
                "invalid_day",
            ),
            (
                json!({ "start_day": "2026-10-05", "end_day": "2026-10-04" }),
                "invalid_range",
            ),
            // 16 days is longer than any period we accept.
            (
                json!({ "start_day": "2026-10-01", "end_day": "2026-10-16" }),
                "invalid_range",
            ),
            (
                json!({ "start_day": "2026-10-01", "end_day": "2026-10-03",
                        "flow": [{ "day": "2026-10-04", "flow": 2 }] }),
                "invalid_flow",
            ),
            (
                // An ongoing period accepts flow up to its 15th day (start + 14), not beyond.
                json!({ "start_day": "2026-10-01", "flow": [{ "day": "2026-10-16", "flow": 2 }] }),
                "invalid_flow",
            ),
            (
                json!({ "start_day": "2026-10-01", "flow": [{ "day": "2026-10-01", "flow": 6 }] }),
                "invalid_flow",
            ),
            (
                json!({ "start_day": "2026-10-01", "flow": [{ "day": "2026-10-01", "flow": 0 }] }),
                "invalid_flow",
            ),
            (
                json!({ "start_day": "2026-10-01",
                        "flow": [{ "day": "2026-10-01", "flow": 2 }, { "day": "2026-10-01", "flow": 3 }] }),
                "invalid_flow",
            ),
            (json!({ "end_day": "2026-10-01" }), "invalid_body"),
            // Days that haven't started anywhere yet (more than a day past the server's date).
            (json!({ "start_day": d(2) }), "future_day"),
            (json!({ "start_day": d(-3), "end_day": d(2) }), "future_day"),
            (
                json!({ "start_day": d(-1), "flow": [{ "day": d(2), "flow": 2 }] }),
                "future_day",
            ),
            // Ongoing but started 16 days ago: it must have ended by now.
            (
                json!({ "start_day": d(-16), "end_day": null }),
                "stale_ongoing",
            ),
        ];
        for (body, code) in cases {
            let (status, response) =
                call(&app, "POST", "/api/periods", &alice, Some(body.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(response, json!({ "error": code }), "{body}");
        }
        // 15 days ago is still accepted (a day of time-zone slack), and an
        // ongoing period may log flow on its 15th day.
        create(
            &app,
            &alice,
            json!({ "start_day": d(-15), "flow": [{ "day": d(-1), "flow": 1 }] }),
        )
        .await;
    }

    #[tokio::test]
    async fn periods_cannot_overlap() {
        let (app, alice, _) = app_with_users().await;
        let first = create(
            &app,
            &alice,
            json!({ "start_day": d(-10), "end_day": d(-8) }),
        )
        .await;

        let conflicts = [
            json!({ "start_day": d(-8), "end_day": d(-7) }), // shares the last day
            json!({ "start_day": d(-12), "end_day": d(-10) }), // shares the first day
            json!({ "start_day": d(-9), "end_day": d(-9) }), // inside
            json!({ "start_day": d(-12), "end_day": null }), // open-ended over it
        ];
        for body in conflicts {
            let (status, response) =
                call(&app, "POST", "/api/periods", &alice, Some(body.clone())).await;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(response, json!({ "error": "overlapping_period" }));
        }

        // Adjacent is fine, and so is an ongoing period after all others...
        create(
            &app,
            &alice,
            json!({ "start_day": d(-7), "end_day": d(-7) }),
        )
        .await;
        create(&app, &alice, json!({ "start_day": d(-3), "end_day": null })).await;
        // ...but nothing can start after an ongoing one.
        let (status, _) = call(
            &app,
            "POST",
            "/api/periods",
            &alice,
            Some(json!({ "start_day": d(-1), "end_day": d(0) })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // A period doesn't conflict with its own old dates when updated.
        let (status, _) = call(
            &app,
            "PUT",
            &format!("/api/periods/{first}"),
            &alice,
            Some(json!({ "start_day": d(-11), "end_day": d(-9) })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn users_cannot_read_or_change_each_others_periods() {
        let (app, alice, bob) = app_with_users().await;
        let id = create(
            &app,
            &alice,
            json!({ "start_day": "2026-10-01", "end_day": "2026-10-04",
                    "flow": [{ "day": "2026-10-01", "flow": 3 }] }),
        )
        .await;

        let (_, list) = call(&app, "GET", "/api/periods", &bob, None).await;
        assert_eq!(list, json!([]));
        let uri = format!("/api/periods/{id}");
        let (status, _) = call(
            &app,
            "PUT",
            &uri,
            &bob,
            Some(json!({ "start_day": "2026-10-02", "end_day": "2026-10-03" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = call(&app, "DELETE", &uri, &bob, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Alice's periods don't block Bob's own on the same days.
        create(
            &app,
            &bob,
            json!({ "start_day": "2026-10-01", "end_day": "2026-10-04" }),
        )
        .await;

        let (_, list) = call(&app, "GET", "/api/periods", &alice, None).await;
        assert_eq!(list[0]["start_day"], "2026-10-01");
        assert_eq!(list[0]["end_day"], "2026-10-04");
        assert_eq!(list[0]["flow"], json!([{ "day": "2026-10-01", "flow": 3 }]));
    }

    #[tokio::test]
    async fn requires_a_session() {
        let (app, _, _) = app_with_users().await;
        for (method, uri) in [
            ("GET", "/api/periods"),
            ("POST", "/api/periods"),
            ("PUT", "/api/periods/1"),
            ("DELETE", "/api/periods/1"),
        ] {
            let (status, _) = call(
                &app,
                method,
                uri,
                "other=1",
                Some(json!({ "start_day": "2026-10-01" })),
            )
            .await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }
}
