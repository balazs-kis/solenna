//! Weigh-ins: one per user per day. `PUT` on a day creates or replaces it.

use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    http::StatusCode,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::{
    AppState,
    api::{is_future_day, is_valid_day},
    auth::CurrentUser,
    db::unix_now,
    error::AppError,
};

/// Plausible human weights; the table has the same CHECK constraint.
const MIN_WEIGHT_G: i64 = 20_000;
const MAX_WEIGHT_G: i64 = 400_000;

#[derive(Serialize)]
pub struct Weight {
    day: String,
    weight_g: i64,
}

#[derive(Deserialize)]
pub struct WeightBody {
    weight_g: i64,
}

/// All of the user's weigh-ins, oldest first. Small enough to send in full;
/// the frontend filters by range.
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<Weight>>, AppError> {
    let weights = state
        .db
        .call(move |conn| Ok(all_weights(conn, user.id)?))
        .await?;
    Ok(Json(weights))
}

/// All weigh-ins of a user, oldest first. Also used by the data export.
pub fn all_weights(conn: &Connection, user_id: i64) -> rusqlite::Result<Vec<Weight>> {
    let mut statement =
        conn.prepare("SELECT day, weight_g FROM weights WHERE user_id = ? ORDER BY day")?;
    let rows = statement.query_map([user_id], |row| {
        Ok(Weight {
            day: row.get(0)?,
            weight_g: row.get(1)?,
        })
    })?;
    rows.collect()
}

pub async fn put(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(day): Path<String>,
    body: Result<Json<WeightBody>, JsonRejection>,
) -> Result<Json<Weight>, AppError> {
    if !is_valid_day(&day) {
        return Err(AppError::BadRequest("invalid_day"));
    }
    if is_future_day(&day) {
        return Err(AppError::BadRequest("future_day"));
    }
    let Json(WeightBody { weight_g }) = body.map_err(|_| AppError::BadRequest("invalid_body"))?;
    if !(MIN_WEIGHT_G..=MAX_WEIGHT_G).contains(&weight_g) {
        return Err(AppError::BadRequest("invalid_weight"));
    }

    let now = unix_now();
    let saved_day = day.clone();
    state
        .db
        .call(move |conn| {
            conn.execute(
                "INSERT INTO weights (user_id, day, weight_g, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT (user_id, day) DO UPDATE
                 SET weight_g = excluded.weight_g, updated_at = excluded.updated_at",
                (user.id, &saved_day, weight_g, now),
            )?;
            Ok(())
        })
        .await?;
    Ok(Json(Weight { day, weight_g }))
}

pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(day): Path<String>,
) -> Result<StatusCode, AppError> {
    let deleted = state
        .db
        .call(move |conn| {
            Ok(conn.execute(
                "DELETE FROM weights WHERE user_id = ? AND day = ?",
                (user.id, &day),
            )?)
        })
        .await?;
    if deleted == 0 {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
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

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let body = body.map_or(Body::empty(), |b| Body::from(b.to_string()));
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
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

    #[tokio::test]
    async fn saves_lists_and_replaces_weigh_ins() {
        let (app, alice, _) = app_with_users().await;
        let a = Some(alice.as_str());

        let (status, body) = call(
            &app,
            "PUT",
            "/api/weights/2026-10-20",
            a,
            Some(json!({ "weight_g": 72_400 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "day": "2026-10-20", "weight_g": 72_400 }));
        call(
            &app,
            "PUT",
            "/api/weights/2026-10-18",
            a,
            Some(json!({ "weight_g": 73_000 })),
        )
        .await;
        // Same day again replaces it.
        call(
            &app,
            "PUT",
            "/api/weights/2026-10-20",
            a,
            Some(json!({ "weight_g": 72_100 })),
        )
        .await;

        let (status, body) = call(&app, "GET", "/api/weights", a, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!([
                { "day": "2026-10-18", "weight_g": 73_000 },
                { "day": "2026-10-20", "weight_g": 72_100 },
            ])
        );
    }

    #[tokio::test]
    async fn rejects_invalid_input() {
        let (app, alice, _) = app_with_users().await;
        let a = Some(alice.as_str());

        let cases = [
            (
                "/api/weights/2026-02-30",
                Some(json!({ "weight_g": 70_000 })),
                "invalid_day",
            ),
            (
                "/api/weights/yesterday",
                Some(json!({ "weight_g": 70_000 })),
                "invalid_day",
            ),
            (
                "/api/weights/2026-10-20",
                Some(json!({ "weight_g": 19_999 })),
                "invalid_weight",
            ),
            (
                "/api/weights/2026-10-20",
                Some(json!({ "weight_g": 400_001 })),
                "invalid_weight",
            ),
            (
                "/api/weights/2026-10-20",
                Some(json!({ "weight_g": 72.5 })),
                "invalid_body",
            ),
            (
                "/api/weights/2026-10-20",
                Some(json!({ "kg": 72 })),
                "invalid_body",
            ),
            ("/api/weights/2026-10-20", None, "invalid_body"),
        ];
        for (uri, body, code) in cases {
            let (status, response) = call(&app, "PUT", uri, a, body.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} {body:?}");
            assert_eq!(response, json!({ "error": code }), "{uri} {body:?}");
        }
        let (_, list) = call(&app, "GET", "/api/weights", a, None).await;
        assert_eq!(list, json!([]));
    }

    #[tokio::test]
    async fn rejects_days_that_havent_started_anywhere() {
        let (app, alice, _) = app_with_users().await;
        let a = Some(alice.as_str());
        let body = || Some(json!({ "weight_g": 70_000 }));

        // Tomorrow by the server's UTC date can already be today east of UTC.
        let tomorrow = format!("/api/weights/{}", day_string(today_number() + 1));
        let (status, _) = call(&app, "PUT", &tomorrow, a, body()).await;
        assert_eq!(status, StatusCode::OK);

        let later = format!("/api/weights/{}", day_string(today_number() + 2));
        let (status, response) = call(&app, "PUT", &later, a, body()).await;
        assert_eq!(
            (status, response),
            (StatusCode::BAD_REQUEST, json!({ "error": "future_day" }))
        );
    }

    #[tokio::test]
    async fn deletes_weigh_ins() {
        let (app, alice, _) = app_with_users().await;
        let a = Some(alice.as_str());
        call(
            &app,
            "PUT",
            "/api/weights/2026-10-20",
            a,
            Some(json!({ "weight_g": 72_400 })),
        )
        .await;

        let (status, _) = call(&app, "DELETE", "/api/weights/2026-10-20", a, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, body) = call(&app, "DELETE", "/api/weights/2026-10-20", a, None).await;
        assert_eq!(
            (status, body),
            (StatusCode::NOT_FOUND, json!({ "error": "not_found" }))
        );
    }

    #[tokio::test]
    async fn requires_a_session() {
        let (app, _, _) = app_with_users().await;
        for (method, uri) in [
            ("GET", "/api/weights"),
            ("PUT", "/api/weights/2026-10-20"),
            ("DELETE", "/api/weights/2026-10-20"),
        ] {
            let (status, _) =
                call(&app, method, uri, None, Some(json!({ "weight_g": 70_000 }))).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn users_cannot_read_or_change_each_others_weigh_ins() {
        let (app, alice, bob) = app_with_users().await;
        let (a, b) = (Some(alice.as_str()), Some(bob.as_str()));
        call(
            &app,
            "PUT",
            "/api/weights/2026-10-20",
            a,
            Some(json!({ "weight_g": 72_400 })),
        )
        .await;

        // Bob sees nothing of Alice's.
        let (_, list) = call(&app, "GET", "/api/weights", b, None).await;
        assert_eq!(list, json!([]));
        // Bob can't delete Alice's day...
        let (status, _) = call(&app, "DELETE", "/api/weights/2026-10-20", b, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // ...and saving the same day creates Bob's own entry, leaving Alice's alone.
        call(
            &app,
            "PUT",
            "/api/weights/2026-10-20",
            b,
            Some(json!({ "weight_g": 90_000 })),
        )
        .await;

        let (_, list) = call(&app, "GET", "/api/weights", a, None).await;
        assert_eq!(list, json!([{ "day": "2026-10-20", "weight_g": 72_400 }]));
        let (_, list) = call(&app, "GET", "/api/weights", b, None).await;
        assert_eq!(list, json!([{ "day": "2026-10-20", "weight_g": 90_000 }]));
    }
}
