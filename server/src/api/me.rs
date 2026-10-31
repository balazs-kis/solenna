//! The signed-in user's own account: settings, the profile handover after
//! sign-in, consent to the privacy notice, data export, and account deletion.

use std::time::Instant;

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::{StatusCode, header},
    response::{AppendHeaders, IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    AppState,
    api::{periods::all_periods, weights::all_weights},
    auth::{CurrentUser, SignedIn, clear_session_cookie},
    db::unix_now,
    error::AppError,
};

/// The languages the frontend has dictionaries for (`web/i18n/*.json`).
pub const LANGUAGES: &[&str] = &["en", "hu"];

#[derive(Serialize, Deserialize)]
pub struct Settings {
    /// `None` until the user picks one; the frontend then uses the browser's language.
    language: Option<String>,
    /// When off, the cycle screen is hidden. Logged periods are kept.
    track_cycle: bool,
    /// When off, fertility and ovulation estimates are hidden.
    show_fertility: bool,
}

/// The signed-in user's settings. 401 when not signed in, which is how the
/// frontend decides to show the login screen. `consented_at` is null until the
/// user agrees to the privacy notice; the frontend asks for that first.
///
/// `profile` (name, email, picture as a `data:` URL) is only there on the
/// session's first call after signing in: the server doesn't store it, so the
/// browser keeps it (see `PendingProfiles`). `id` lets the browser tell whether
/// a profile it kept belongs to this user.
pub async fn get(State(state): State<AppState>, user: SignedIn) -> Result<Json<Value>, AppError> {
    let user_id = user.id;
    let (settings, consented_at) = state
        .db
        .call(move |conn| {
            let settings = read_settings(conn, user_id)?;
            Ok((settings, read_consent(conn, user_id)?))
        })
        .await?;
    // Only now: if the read had failed, the one-time profile would be lost.
    let profile = state.profiles.take(&user.session, Instant::now());
    let profile = profile.map(|profile| {
        json!({
            "name": profile.name,
            "email": profile.email,
            "avatar": profile.avatar.map(|avatar| avatar.data_url()),
        })
    });
    Ok(Json(json!({
        "id": user_id,
        "consented_at": consented_at,
        "settings": settings,
        "profile": profile,
    })))
}

/// When the user agreed to the privacy notice (Unix seconds), if they have.
fn read_consent(conn: &rusqlite::Connection, user_id: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT consented_at FROM users WHERE id = ?",
        [user_id],
        |row| row.get(0),
    )
}

/// The user agrees to the privacy notice: explicit consent to storing their
/// health data. Until then every data route answers 403 `consent_required`
/// (see `CurrentUser`). Agreeing again keeps the first date.
pub async fn consent(
    State(state): State<AppState>,
    user: SignedIn,
) -> Result<Json<Value>, AppError> {
    let now = unix_now();
    let consented_at = state
        .db
        .call(move |conn| {
            conn.execute(
                "UPDATE users SET consented_at = ?1, updated_at = ?1
                 WHERE id = ?2 AND consented_at IS NULL",
                (now, user.id),
            )?;
            Ok(read_consent(conn, user.id)?)
        })
        .await?;
    tracing::info!("user {} agreed to the privacy notice", user.id);
    Ok(Json(json!({ "consented_at": consented_at })))
}

fn read_settings(conn: &rusqlite::Connection, user_id: i64) -> rusqlite::Result<Settings> {
    conn.query_row(
        "SELECT language, track_cycle, show_fertility FROM users WHERE id = ?",
        [user_id],
        |row| {
            Ok(Settings {
                language: row.get(0)?,
                track_cycle: row.get(1)?,
                show_fertility: row.get(2)?,
            })
        },
    )
}

/// Replaces all settings at once.
pub async fn put_settings(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Result<Json<Settings>, JsonRejection>,
) -> Result<Json<Settings>, AppError> {
    let Json(settings) = body.map_err(|_| AppError::BadRequest("invalid_body"))?;
    if let Some(language) = &settings.language
        && !LANGUAGES.contains(&language.as_str())
    {
        return Err(AppError::BadRequest("invalid_language"));
    }

    let now = unix_now();
    state
        .db
        .call(move |conn| {
            conn.execute(
                "UPDATE users SET language = ?, track_cycle = ?, show_fertility = ?, updated_at = ?
                 WHERE id = ?",
                (
                    &settings.language,
                    settings.track_cycle,
                    settings.show_fertility,
                    now,
                    user.id,
                ),
            )?;
            Ok(settings)
        })
        .await
        .map(Json)
}

/// Everything the server stores about the user, as one JSON document. The
/// browser adds the name, email and picture it keeps (the server has none).
pub async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let export = state
        .db
        .call(move |conn| {
            let tx = conn.transaction()?;
            let (created_at, consented_at): (i64, Option<i64>) = tx.query_row(
                "SELECT created_at, consented_at FROM users WHERE id = ?",
                [user.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let account = json!({ "created_at": created_at, "consented_at": consented_at });
            let settings = read_settings(&tx, user.id)?;
            Ok(json!({
                "format": "solenna-export",
                "version": 1,
                "exported_at": unix_now(),
                "account": account,
                "settings": settings,
                "weights": all_weights(&tx, user.id)?,
                "periods": all_periods(&tx, user.id)?,
            }))
        })
        .await?;
    Ok(Json(export))
}

/// Hard-deletes the user. Their sessions, weigh-ins and periods go with them
/// (`ON DELETE CASCADE`), and this browser's session cookie is cleared. Also
/// how a user declines the privacy notice, so it doesn't need consent.
/// secure_delete zeroes the rows, but in WAL mode the old pages stay in the
/// files until a checkpoint, so one runs straight away (see `db::checkpoint`).
pub async fn delete(State(state): State<AppState>, user: SignedIn) -> Result<Response, AppError> {
    let user_id = user.id;
    state
        .db
        .call(move |conn| {
            conn.execute("DELETE FROM users WHERE id = ?", [user_id])?;
            // The account is gone at this point; a failed checkpoint mustn't
            // turn that into an error (the next one catches up).
            if crate::db::checkpoint(conn).is_err() {
                tracing::error!("WAL checkpoint after an account deletion failed");
            }
            Ok(())
        })
        .await?;
    tracing::info!("deleted account of user {user_id}");
    Ok((
        AppendHeaders([(header::SET_COOKIE, clear_session_cookie(&state.config))]),
        StatusCode::NO_CONTENT,
    )
        .into_response())
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
        auth::{test_session, test_session_without_consent},
        router, test_state,
    };

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

    /// Gives a user one weigh-in and one period with a flow day.
    async fn add_data(app: &Router, cookie: &str, weight_g: i64) {
        let weight = json!({ "weight_g": weight_g });
        let (status, _) = call(app, "PUT", "/api/weights/2026-10-20", cookie, Some(weight)).await;
        assert_eq!(status, StatusCode::OK);
        let period = json!({
            "start_day": "2026-10-01",
            "end_day": "2026-10-05",
            "flow": [{ "day": "2026-10-01", "flow": 3 }],
        });
        let (status, _) = call(app, "POST", "/api/periods", cookie, Some(period)).await;
        assert_eq!(status, StatusCode::CREATED);
    }

    #[tokio::test]
    async fn no_identity_is_stored() {
        let state = test_state();
        test_session(&state, "1234567890", "alice@example.com").await;
        let dump: String = state
            .db
            .call(|conn| {
                let mut statement = conn.prepare("SELECT * FROM users")?;
                let columns = statement.column_count();
                let rows = statement.query_map([], |row| {
                    let mut values = Vec::new();
                    for i in 0..columns {
                        values.push(format!("{:?}", row.get_ref(i)?));
                    }
                    Ok(values.join(","))
                })?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?.join("\n"))
            })
            .await
            .unwrap();
        assert!(!dump.contains("1234567890"), "raw sub stored: {dump}");
        assert!(!dump.contains("alice"), "email stored: {dump}");
    }

    #[tokio::test]
    async fn new_users_get_default_settings() {
        let (app, alice, _) = app_with_users().await;
        let (status, body) = call(&app, "GET", "/api/me", &alice, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["settings"],
            json!({ "language": null, "track_cycle": true, "show_fertility": true })
        );
    }

    #[tokio::test]
    async fn saves_settings_per_user() {
        let (app, alice, bob) = app_with_users().await;
        let settings = json!({ "language": "hu", "track_cycle": true, "show_fertility": false });

        let (status, body) = call(
            &app,
            "PUT",
            "/api/me/settings",
            &alice,
            Some(settings.clone()),
        )
        .await;
        assert_eq!((status, &body), (StatusCode::OK, &settings));

        let (_, me) = call(&app, "GET", "/api/me", &alice, None).await;
        assert_eq!(me["settings"], settings);
        // Bob's settings are untouched.
        let (_, me) = call(&app, "GET", "/api/me", &bob, None).await;
        assert_eq!(me["settings"]["language"], Value::Null);
        assert_eq!(me["settings"]["show_fertility"], json!(true));
    }

    #[tokio::test]
    async fn rejects_invalid_settings() {
        let (app, alice, _) = app_with_users().await;
        let cases = [
            (
                json!({ "language": "de", "track_cycle": true, "show_fertility": true }),
                "invalid_language",
            ),
            (
                json!({ "language": null, "track_cycle": 1, "show_fertility": true }),
                "invalid_body",
            ),
            (json!({ "language": "en" }), "invalid_body"),
        ];
        for (body, code) in cases {
            let (status, response) =
                call(&app, "PUT", "/api/me/settings", &alice, Some(body.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(response, json!({ "error": code }), "{body}");
        }
    }

    #[tokio::test]
    async fn export_contains_only_the_users_own_data() {
        let (app, alice, bob) = app_with_users().await;
        add_data(&app, &alice, 72_400).await;
        add_data(&app, &bob, 90_000).await;

        let (status, export) = call(&app, "GET", "/api/me/export", &alice, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(export["format"], json!("solenna-export"));
        // No identity on the server's side of the export: the browser adds its own.
        assert_eq!(
            export["account"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["consented_at", "created_at"]
        );
        assert_eq!(
            export["weights"],
            json!([{ "day": "2026-10-20", "weight_g": 72_400 }])
        );
        let periods = export["periods"].as_array().unwrap();
        assert_eq!(periods.len(), 1);
        assert_eq!(
            periods[0]["flow"],
            json!([{ "day": "2026-10-01", "flow": 3 }])
        );
        assert_eq!(export["settings"]["track_cycle"], json!(true));
    }

    #[tokio::test]
    async fn deleting_the_account_removes_all_its_data_and_nothing_else() {
        let state = test_state();
        let alice = test_session(&state, "sub-a", "alice@example.com").await;
        let bob = test_session(&state, "sub-b", "bob@example.com").await;
        let db = state.db.clone();
        let app = router(state);
        add_data(&app, &alice, 72_400).await;
        add_data(&app, &bob, 90_000).await;

        let request = Request::delete("/api/me")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &alice)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("Max-Age=0"), "{cookie}");

        // Alice's session is gone; Bob still has everything.
        let (status, _) = call(&app, "GET", "/api/me", &alice, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (_, export) = call(&app, "GET", "/api/me/export", &bob, None).await;
        assert_eq!(export["weights"].as_array().unwrap().len(), 1);
        assert_eq!(export["periods"].as_array().unwrap().len(), 1);

        // No row of Alice's is left in any table.
        let counts: Vec<i64> = db
            .call(|conn| {
                let mut counts = Vec::new();
                for sql in [
                    "SELECT COUNT(*) FROM users",
                    "SELECT COUNT(*) FROM sessions",
                    "SELECT COUNT(*) FROM weights",
                    "SELECT COUNT(*) FROM periods",
                    "SELECT COUNT(*) FROM period_flow",
                ] {
                    counts.push(conn.query_row(sql, [], |row| row.get(0))?);
                }
                Ok(counts)
            })
            .await
            .unwrap();
        assert_eq!(counts, [1, 1, 1, 1, 1], "only Bob's rows remain");
    }

    #[tokio::test]
    async fn deleted_accounts_leave_nothing_in_the_database_files() {
        /// Removed again even if the test fails.
        struct TempDir(std::path::PathBuf);
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let temp = TempDir(
            std::env::temp_dir().join(format!("solenna-delete-test-{}", std::process::id())),
        );
        let dir = temp.0.clone();
        std::fs::create_dir_all(&dir).unwrap();
        let state = crate::AppState::new(
            crate::db::Db::open(&dir.join("solenna.db")).unwrap(),
            crate::config::Config::for_tests(),
        );
        let alice = test_session(&state, "sub-a", "alice@example.com").await;
        let app = router(state);
        add_data(&app, &alice, 72_400).await;

        // The user's row (and so its sub_hash) is somewhere in the files...
        let marker = crate::auth::sub_hash("sub-a").into_bytes();
        let files_contain = |marker: &[u8]| {
            std::fs::read_dir(&dir).unwrap().any(|entry| {
                let bytes = std::fs::read(entry.unwrap().path()).unwrap();
                bytes.windows(marker.len()).any(|window| window == marker)
            })
        };
        assert!(
            files_contain(&marker),
            "the test needs the marker to be there first"
        );

        let (status, _) = call(&app, "DELETE", "/api/me", &alice, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        // ...and in none of them after the account is deleted, WAL included.
        assert!(
            !files_contain(&marker),
            "deleted account still in the files"
        );
        drop(app); // Closes the database before TempDir removes it.
    }

    #[tokio::test]
    async fn nothing_is_stored_or_shown_before_consent() {
        let state = test_state();
        let carol = test_session_without_consent(&state, "sub-c", "carol@example.com").await;
        let app = router(state);

        let (status, me) = call(&app, "GET", "/api/me", &carol, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(me["consented_at"], Value::Null);

        let settings = json!({ "language": "hu", "track_cycle": true, "show_fertility": true });
        let period = json!({ "start_day": "2026-10-01", "end_day": "2026-10-05" });
        for (method, uri, body) in [
            ("GET", "/api/weights", None),
            (
                "PUT",
                "/api/weights/2026-10-20",
                Some(json!({ "weight_g": 72_400 })),
            ),
            ("DELETE", "/api/weights/2026-10-20", None),
            ("GET", "/api/periods", None),
            ("POST", "/api/periods", Some(period.clone())),
            ("PUT", "/api/periods/1", Some(period)),
            ("DELETE", "/api/periods/1", None),
            ("PUT", "/api/me/settings", Some(settings)),
            ("GET", "/api/me/export", None),
        ] {
            let (status, body) = call(&app, method, uri, &carol, body).await;
            assert_eq!(
                (status, body),
                (
                    StatusCode::FORBIDDEN,
                    json!({ "error": "consent_required" })
                ),
                "{method} {uri}"
            );
        }
    }

    #[tokio::test]
    async fn consenting_unlocks_the_data_routes_and_keeps_the_first_date() {
        let state = test_state();
        let carol = test_session_without_consent(&state, "sub-c", "carol@example.com").await;
        let app = router(state);

        let (status, first) = call(&app, "POST", "/api/me/consent", &carol, None).await;
        assert_eq!(status, StatusCode::OK);
        let consented_at = first["consented_at"].as_i64().unwrap();
        let (_, me) = call(&app, "GET", "/api/me", &carol, None).await;
        assert_eq!(me["consented_at"], json!(consented_at));

        let (_, again) = call(&app, "POST", "/api/me/consent", &carol, None).await;
        assert_eq!(again, first);
        add_data(&app, &carol, 60_000).await;
    }

    #[tokio::test]
    async fn declining_deletes_the_sign_in() {
        let state = test_state();
        let carol = test_session_without_consent(&state, "sub-c", "carol@example.com").await;
        let db = state.db.clone();
        let app = router(state);

        let (status, _) = call(&app, "DELETE", "/api/me", &carol, None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = call(&app, "GET", "/api/me", &carol, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let users: i64 = db
            .call(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?))
            .await
            .unwrap();
        assert_eq!(users, 0);
    }

    #[tokio::test]
    async fn requires_a_session() {
        let (app, _, _) = app_with_users().await;
        for (method, uri) in [
            ("GET", "/api/me"),
            ("PUT", "/api/me/settings"),
            ("GET", "/api/me/export"),
            ("DELETE", "/api/me"),
            ("POST", "/api/me/consent"),
        ] {
            let (status, _) = call(&app, method, uri, "other=1", Some(json!({}))).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }
}
