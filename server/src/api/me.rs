//! The signed-in user's own account: profile and settings, profile picture,
//! data export, and account deletion.

use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{AppendHeaders, IntoResponse, Response},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    AppState,
    api::{periods::all_periods, weights::all_weights},
    auth::{CurrentUser, clear_session_cookie},
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

/// The signed-in user's profile and settings. 401 when not signed in, which is
/// how the frontend decides to show the login screen. `avatar` says whether
/// `GET /api/me/avatar` has a picture.
pub async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let (email, name, avatar, settings): (String, String, bool, Settings) = state
        .db
        .call(move |conn| {
            Ok(conn.query_row(
                "SELECT email, name, avatar IS NOT NULL, language, track_cycle, show_fertility
                 FROM users WHERE id = ?",
                [user.id],
                |row| {
                    let settings = Settings {
                        language: row.get(3)?,
                        track_cycle: row.get(4)?,
                        show_fertility: row.get(5)?,
                    };
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, settings))
                },
            )?)
        })
        .await?;
    Ok(Json(json!({
        "email": email,
        "name": name,
        "avatar": avatar,
        "settings": settings,
    })))
}

/// The profile picture saved at sign-in; 404 if there is none. The browser
/// revalidates it on each load (it changes when the user signs in again), and
/// the ETag makes that a cheap 304.
pub async fn avatar(
    State(state): State<AppState>,
    user: CurrentUser,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let found: Option<(Vec<u8>, String)> = state
        .db
        .call(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT avatar, avatar_type FROM users WHERE id = ? AND avatar IS NOT NULL",
                    [user.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })
        .await?;
    let Some((bytes, content_type)) = found else {
        return Err(AppError::NotFound);
    };

    let etag = format!(
        "\"{}\"",
        URL_SAFE_NO_PAD.encode(&Sha256::digest(&bytes)[..12])
    );
    let cache = [
        (header::ETAG, etag.clone()),
        (header::CACHE_CONTROL, "private, no-cache".to_string()),
    ];
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|value| value.as_bytes() == etag.as_bytes());
    if unchanged {
        return Ok((StatusCode::NOT_MODIFIED, cache).into_response());
    }
    Ok((cache, [(header::CONTENT_TYPE, content_type)], bytes).into_response())
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

/// Everything stored about the user, as one JSON document.
pub async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Value>, AppError> {
    let export = state
        .db
        .call(move |conn| {
            let tx = conn.transaction()?;
            let (account, settings) = tx.query_row(
                "SELECT email, name, created_at, language, track_cycle, show_fertility,
                        avatar, avatar_type
                 FROM users WHERE id = ?",
                [user.id],
                |row| {
                    let avatar_type: Option<String> = row.get(7)?;
                    let avatar = row.get::<_, Option<Vec<u8>>>(6)?.map(
                        |bytes| json!({ "type": avatar_type, "base64": STANDARD.encode(bytes) }),
                    );
                    let account = json!({
                        "email": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "created_at": row.get::<_, i64>(2)?,
                        "avatar": avatar,
                    });
                    let settings = Settings {
                        language: row.get(3)?,
                        track_cycle: row.get(4)?,
                        show_fertility: row.get(5)?,
                    };
                    Ok((account, settings))
                },
            )?;
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
/// (`ON DELETE CASCADE`), and this browser's session cookie is cleared.
pub async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Response, AppError> {
    let user_id = user.id;
    state
        .db
        .call(move |conn| {
            conn.execute("DELETE FROM users WHERE id = ?", [user_id])?;
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

    use crate::{auth::test_session, router, test_state};

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
        assert_eq!(export["account"]["email"], json!("alice@example.com"));
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
    async fn serves_only_the_users_own_picture() {
        let state = test_state();
        let alice = test_session(&state, "sub-a", "alice@example.com").await;
        let bob = test_session(&state, "sub-b", "bob@example.com").await;
        state
            .db
            .call(|conn| {
                conn.execute(
                    "UPDATE users SET avatar = ?, avatar_type = 'image/png' WHERE google_sub = 'sub-a'",
                    [b"\x89PNG\r\n\x1a\nalice".as_slice()],
                )?;
                Ok(())
            })
            .await
            .unwrap();
        let app = router(state);
        let get_avatar = |cookie: &str, etag: Option<&str>| {
            let mut request = Request::get("/api/me/avatar").header(header::COOKIE, cookie);
            if let Some(etag) = etag {
                request = request.header(header::IF_NONE_MATCH, etag);
            }
            app.clone().oneshot(request.body(Body::empty()).unwrap())
        };

        let response = get_avatar(&alice, None).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&bytes[..], b"\x89PNG\r\n\x1a\nalice");

        let response = get_avatar(&alice, Some(&etag)).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);

        // Bob has no picture, and never gets Alice's.
        let response = get_avatar(&bob, None).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let (_, me) = call(&app, "GET", "/api/me", &alice, None).await;
        assert_eq!(me["avatar"], json!(true));
        let (_, me) = call(&app, "GET", "/api/me", &bob, None).await;
        assert_eq!(me["avatar"], json!(false));
        let (_, export) = call(&app, "GET", "/api/me/export", &alice, None).await;
        assert_eq!(export["account"]["avatar"]["type"], json!("image/png"));
        let (_, export) = call(&app, "GET", "/api/me/export", &bob, None).await;
        assert_eq!(export["account"]["avatar"], Value::Null);
    }

    #[tokio::test]
    async fn requires_a_session() {
        let (app, _, _) = app_with_users().await;
        for (method, uri) in [
            ("GET", "/api/me"),
            ("GET", "/api/me/avatar"),
            ("PUT", "/api/me/settings"),
            ("GET", "/api/me/export"),
            ("DELETE", "/api/me"),
        ] {
            let (status, _) = call(&app, method, uri, "other=1", Some(json!({}))).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }
}
