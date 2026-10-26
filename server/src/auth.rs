//! Google sign-in (OpenID Connect authorization code flow with PKCE) and sessions.
//!
//! Flow: `GET /auth/google` stores a random `state` and PKCE verifier in a
//! short-lived HttpOnly cookie and redirects to Google. Google redirects back to
//! `GET /auth/google/callback`, which checks `state`, exchanges the code for an
//! ID token, upserts the user and starts a session. Failures redirect to
//! `/?auth_error=cancelled|failed` for the frontend to show.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::{FromRequestParts, Query, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{AppendHeaders, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{AppState, config::Config, db::unix_now, error::AppError};

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

const SESSION_COOKIE: &str = "solenna_session";
const OAUTH_COOKIE: &str = "solenna_oauth";
/// How long the user has to finish signing in at Google.
const OAUTH_COOKIE_MAX_AGE: i64 = 10 * 60;

/// Server-side session lifetime, extended on use (sliding).
const SESSION_TTL: i64 = 30 * 24 * 60 * 60;
/// The sliding extension is written at most this often per session, so ordinary
/// requests don't write to the DB.
const SESSION_REFRESH_INTERVAL: i64 = 24 * 60 * 60;
/// The cookie itself lives long (400 days is the browser maximum); the DB expiry
/// above is what actually ends a session.
const SESSION_COOKIE_MAX_AGE: i64 = 400 * 24 * 60 * 60;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/google", get(start))
        .route("/auth/google/callback", get(callback))
        .route("/auth/logout", post(logout))
}

/// The signed-in user. Use it as a handler argument; requests without a valid
/// session are rejected with 401 before the handler runs.
pub struct CurrentUser {
    pub id: i64,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let token = read_cookie(&parts.headers, SESSION_COOKIE).ok_or(AppError::Unauthorized)?;
        let hash = hash_token(&token);
        let now = unix_now();
        let user_id = state
            .db
            .call(move |conn| lookup_session(conn, &hash, now))
            .await?;
        user_id
            .map(|id| CurrentUser { id })
            .ok_or(AppError::Unauthorized)
    }
}

/// Fixed-window limit on all auth requests together. A per-IP limit would mean
/// trusting `X-Forwarded-For` from the proxy; a global one is enough here, since
/// it only has to stop someone hammering the endpoints (and Google through us).
pub struct RateLimiter {
    max: u32,
    window: Duration,
    current: Mutex<(Instant, u32)>,
}

impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            current: Mutex::new((Instant::now(), 0)),
        }
    }

    pub fn check(&self) -> Result<(), AppError> {
        let mut current = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let (started, count) = &mut *current;
        if started.elapsed() >= self.window {
            *started = Instant::now();
            *count = 0;
        }
        if *count >= self.max {
            tracing::warn!("auth rate limit reached");
            return Err(AppError::RateLimited);
        }
        *count += 1;
        Ok(())
    }
}

async fn start(State(state): State<AppState>) -> Result<Response, AppError> {
    let csrf_state = random_token();
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let mut url = Url::parse(GOOGLE_AUTH_URL).expect("valid URL constant");
    url.query_pairs_mut()
        .append_pair("client_id", &state.config.google_client_id)
        .append_pair("redirect_uri", &redirect_uri(&state.config))
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", &csrf_state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "select_account");

    let oauth_cookie = cookie(
        OAUTH_COOKIE,
        &format!("{csrf_state}.{verifier}"),
        "/auth",
        OAUTH_COOKIE_MAX_AGE,
        state.config.secure_cookies(),
    );
    Ok((
        AppendHeaders([(header::SET_COOKIE, oauth_cookie)]),
        Redirect::to(url.as_str()),
    )
        .into_response())
}

#[derive(Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

enum LoginError {
    Cancelled,
    Failed,
}

async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CallbackParams>,
) -> Response {
    let secure = state.config.secure_cookies();
    let clear_oauth = cookie(OAUTH_COOKIE, "", "/auth", 0, secure);

    match finish_login(&state, &headers, params).await {
        Ok(token) => (
            AppendHeaders([
                (header::SET_COOKIE, clear_oauth),
                (
                    header::SET_COOKIE,
                    cookie(SESSION_COOKIE, &token, "/", SESSION_COOKIE_MAX_AGE, secure),
                ),
            ]),
            Redirect::to("/"),
        )
            .into_response(),
        Err(error) => {
            let reason = match error {
                LoginError::Cancelled => "cancelled",
                LoginError::Failed => "failed",
            };
            (
                AppendHeaders([(header::SET_COOKIE, clear_oauth)]),
                Redirect::to(&format!("/?auth_error={reason}")),
            )
                .into_response()
        }
    }
}

/// Never logs codes, tokens, the verifier or the client secret.
async fn finish_login(
    state: &AppState,
    headers: &HeaderMap,
    params: CallbackParams,
) -> Result<String, LoginError> {
    if let Some(error) = params.error {
        // The value comes from the query string, so only known codes are logged.
        tracing::info!(
            "google sign-in returned error: {}",
            known_oauth_error(&error).unwrap_or("unrecognized")
        );
        return Err(if error == "access_denied" {
            LoginError::Cancelled
        } else {
            LoginError::Failed
        });
    }

    let oauth_cookie = read_cookie(headers, OAUTH_COOKIE).ok_or_else(|| {
        tracing::warn!("sign-in callback without oauth cookie (expired or different browser)");
        LoginError::Failed
    })?;
    let (expected_state, verifier) = oauth_cookie.split_once('.').ok_or(LoginError::Failed)?;
    if params.state.as_deref() != Some(expected_state) {
        tracing::warn!("sign-in callback with mismatched state");
        return Err(LoginError::Failed);
    }
    let code = params.code.ok_or(LoginError::Failed)?;

    // Only the call to Google does real work, so that's what gets rate limited.
    state.auth_limiter.check().map_err(|_| LoginError::Failed)?;
    let id_token = exchange_code(state, &code, verifier).await?;
    let now = unix_now();
    let claims = verify_id_token(&id_token, &state.config.google_client_id, now).map_err(|e| {
        tracing::warn!("rejected ID token: {e}");
        LoginError::Failed
    })?;

    // Signing in again in this browser replaces its previous session.
    let previous = read_cookie(headers, SESSION_COOKIE).map(|token| hash_token(&token));
    state
        .db
        .call(move |conn| login_user(conn, &claims, now, previous))
        .await
        .map_err(|_| LoginError::Failed)
}

/// Error codes Google's authorization endpoint documents (RFC 6749 4.1.2.1 plus
/// OpenID Connect's), as static strings safe to log.
fn known_oauth_error(error: &str) -> Option<&'static str> {
    [
        "access_denied",
        "invalid_request",
        "unauthorized_client",
        "unsupported_response_type",
        "invalid_scope",
        "server_error",
        "temporarily_unavailable",
        "admin_policy_enforced",
        "interaction_required",
        "login_required",
        "account_selection_required",
        "consent_required",
    ]
    .into_iter()
    .find(|known| *known == error)
}

async fn exchange_code(state: &AppState, code: &str, verifier: &str) -> Result<String, LoginError> {
    #[derive(Deserialize)]
    struct TokenResponse {
        id_token: String,
    }

    let redirect_uri = redirect_uri(&state.config);
    let response = state
        .http
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", &redirect_uri),
            ("client_id", &state.config.google_client_id),
            ("client_secret", &state.config.google_client_secret),
        ])
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("token request failed: {e}");
            LoginError::Failed
        })?;

    if !response.status().is_success() {
        tracing::warn!("token endpoint returned {}", response.status());
        return Err(LoginError::Failed);
    }
    let body: TokenResponse = response.json().await.map_err(|e| {
        tracing::warn!("unreadable token response: {e}");
        LoginError::Failed
    })?;
    Ok(body.id_token)
}

#[derive(Deserialize)]
struct IdClaims {
    iss: String,
    aud: String,
    exp: i64,
    sub: String,
    email: String,
    #[serde(default)]
    name: String,
}

/// The ID token comes straight from Google's token endpoint over TLS, so the TLS
/// server check stands in for verifying its signature (OpenID Connect Core
/// 3.1.3.7). We still check who issued it, for whom, and that it hasn't expired.
fn verify_id_token(id_token: &str, client_id: &str, now: i64) -> Result<IdClaims, &'static str> {
    let payload = id_token.split('.').nth(1).ok_or("malformed")?;
    let json = URL_SAFE_NO_PAD.decode(payload).map_err(|_| "malformed")?;
    let claims: IdClaims = serde_json::from_slice(&json).map_err(|_| "malformed")?;

    if !matches!(
        claims.iss.as_str(),
        "https://accounts.google.com" | "accounts.google.com"
    ) {
        return Err("wrong issuer");
    }
    if claims.aud != client_id {
        return Err("wrong audience");
    }
    if claims.exp <= now {
        return Err("expired");
    }
    Ok(claims)
}

/// Creates or updates the user and starts a session, ending `previous` (the hash
/// of the browser's old session, if any). Returns the session token for the
/// cookie; only its hash is stored.
fn login_user(
    conn: &mut Connection,
    claims: &IdClaims,
    now: i64,
    previous: Option<Vec<u8>>,
) -> Result<String, AppError> {
    let tx = conn.transaction()?;
    if let Some(previous) = previous {
        tx.execute("DELETE FROM sessions WHERE token_hash = ?", [previous])?;
    }
    let user_id: i64 = tx.query_row(
        "INSERT INTO users (google_sub, email, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT (google_sub) DO UPDATE
         SET email = excluded.email, name = excluded.name, updated_at = excluded.updated_at
         RETURNING id",
        (&claims.sub, &claims.email, &claims.name, now),
        |row| row.get(0),
    )?;
    // Housekeeping: logins are rare enough to clean up expired sessions here.
    tx.execute("DELETE FROM sessions WHERE expires_at <= ?", [now])?;

    let token = random_token();
    tx.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        (hash_token(&token), user_id, now, now + SESSION_TTL),
    )?;
    tx.commit()?;
    Ok(token)
}

/// Returns the session's user, extending the session if it is due.
fn lookup_session(conn: &mut Connection, hash: &[u8], now: i64) -> Result<Option<i64>, AppError> {
    let session: Option<(i64, i64)> = conn
        .query_row(
            "SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
            (hash, now),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((user_id, expires_at)) = session else {
        return Ok(None);
    };

    if now + SESSION_TTL - expires_at >= SESSION_REFRESH_INTERVAL {
        conn.execute(
            "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
            (now + SESSION_TTL, hash),
        )?;
    }
    Ok(Some(user_id))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(token) = read_cookie(&headers, SESSION_COOKIE) {
        let hash = hash_token(&token);
        state
            .db
            .call(move |conn| {
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", [hash])?;
                Ok(())
            })
            .await?;
    }
    let clear = cookie(SESSION_COOKIE, "", "/", 0, state.config.secure_cookies());
    Ok((
        AppendHeaders([(header::SET_COOKIE, clear)]),
        StatusCode::NO_CONTENT,
    )
        .into_response())
}

fn redirect_uri(config: &Config) -> String {
    format!("{}/auth/google/callback", config.base_url)
}

/// 32 random bytes from the OS, base64url-encoded (43 characters).
fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS random number generator unavailable");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn cookie(name: &str, value: &str, path: &str, max_age: i64, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
}

fn read_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

/// Signs a user in directly (skipping Google) and returns a `Cookie` header
/// value for their session. For tests of any route that needs a session.
#[cfg(test)]
pub async fn test_session(state: &AppState, sub: &'static str, email: &'static str) -> String {
    let claims = IdClaims {
        iss: "https://accounts.google.com".into(),
        aud: state.config.google_client_id.clone(),
        exp: i64::MAX,
        sub: sub.into(),
        email: email.into(),
        name: String::new(),
    };
    let token = state
        .db
        .call(move |conn| login_user(conn, &claims, unix_now(), None))
        .await
        .unwrap();
    format!("{SESSION_COOKIE}={token}")
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, header::HeaderValue},
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;
    use crate::{router, test_state};

    const NOW: i64 = 1_800_000_000;

    fn id_token(claims: Value) -> String {
        let encode = |v: &Value| URL_SAFE_NO_PAD.encode(v.to_string());
        format!(
            "{}.{}.signature",
            encode(&json!({ "alg": "RS256" })),
            encode(&claims)
        )
    }

    fn claims(sub: &str, email: &str) -> IdClaims {
        IdClaims {
            iss: "https://accounts.google.com".into(),
            aud: "test-client-id".into(),
            exp: NOW + 3600,
            sub: sub.into(),
            email: email.into(),
            name: String::new(),
        }
    }

    async fn send(app: &Router, request: Request<Body>) -> Response {
        app.clone().oneshot(request).await.unwrap()
    }

    fn get(uri: &str, cookie: Option<&str>) -> Request<Body> {
        let mut request = Request::get(uri);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(Body::empty()).unwrap()
    }

    fn set_cookies(response: &Response) -> Vec<String> {
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|v| v.to_str().unwrap().to_string())
            .collect()
    }

    fn location(response: &Response) -> &str {
        response.headers()[header::LOCATION].to_str().unwrap()
    }

    async fn session_for(state: &AppState, sub: &'static str, email: &'static str) -> String {
        test_session(state, sub, email).await
    }

    async fn session_count(state: &AppState) -> i64 {
        state
            .db
            .call(|conn| Ok(conn.query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?))
            .await
            .unwrap()
    }

    #[test]
    fn accepts_valid_id_token() {
        let token = id_token(json!({
            "iss": "https://accounts.google.com", "aud": "test-client-id", "exp": NOW + 60,
            "sub": "123", "email": "a@example.com", "name": "A"
        }));
        let claims = verify_id_token(&token, "test-client-id", NOW).unwrap();
        assert_eq!(
            (claims.sub.as_str(), claims.email.as_str()),
            ("123", "a@example.com")
        );
    }

    #[test]
    fn rejects_bad_id_tokens() {
        let base = json!({
            "iss": "accounts.google.com", "aud": "test-client-id", "exp": NOW + 60,
            "sub": "123", "email": "a@example.com"
        });
        let with = |key: &str, value: Value| {
            let mut claims = base.clone();
            claims[key] = value;
            id_token(claims)
        };

        let cases = [
            (with("iss", json!("https://evil.example")), "wrong issuer"),
            (with("aud", json!("other-client")), "wrong audience"),
            (with("exp", json!(NOW)), "expired"),
            ("not-a-jwt".to_string(), "malformed"),
            (with("email", Value::Null), "malformed"),
        ];
        for (token, expected) in cases {
            assert_eq!(
                verify_id_token(&token, "test-client-id", NOW).err(),
                Some(expected)
            );
        }
    }

    #[tokio::test]
    async fn repeat_login_updates_the_same_user() {
        let state = test_state();
        let first = session_for(&state, "sub-1", "old@example.com").await;
        let second = session_for(&state, "sub-1", "new@example.com").await;
        assert_ne!(first, second, "each login gets its own session");

        let (users, email): (i64, String) = state
            .db
            .call(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*), MAX(email) FROM users", [], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?,
                )
            })
            .await
            .unwrap();
        assert_eq!((users, email.as_str()), (1, "new@example.com"));
    }

    #[tokio::test]
    async fn login_replaces_the_browsers_previous_session() {
        let state = test_state();
        let old = session_for(&state, "sub-1", "a@example.com").await;
        let _other_device = session_for(&state, "sub-1", "a@example.com").await;
        assert_eq!(session_count(&state).await, 2);

        let old_hash = hash_token(old.strip_prefix("solenna_session=").unwrap());
        state
            .db
            .call(move |conn| {
                login_user(
                    conn,
                    &claims("sub-2", "b@example.com"),
                    unix_now(),
                    Some(old_hash),
                )
            })
            .await
            .unwrap();
        // The old session is gone; the other device's session and the new one remain.
        assert_eq!(session_count(&state).await, 2);
        let response = send(&router(state), get("/api/me", Some(&old))).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sessions_expire_and_slide() {
        let state = test_state();
        let token = state
            .db
            .call(|conn| login_user(conn, &claims("sub", "a@example.com"), NOW, None))
            .await
            .unwrap();
        let hash = hash_token(&token);

        let expires_at = |state: AppState, hash: Vec<u8>| async move {
            state
                .db
                .call(move |conn| {
                    Ok(conn.query_row(
                        "SELECT expires_at FROM sessions WHERE token_hash = ?",
                        [hash],
                        |row| row.get::<_, i64>(0),
                    )?)
                })
                .await
                .unwrap()
        };
        let lookup = |state: AppState, hash: Vec<u8>, now: i64| async move {
            state
                .db
                .call(move |conn| lookup_session(conn, &hash, now))
                .await
                .unwrap()
        };

        // Within the refresh interval: valid, no write.
        assert!(
            lookup(state.clone(), hash.clone(), NOW + 60)
                .await
                .is_some()
        );
        assert_eq!(
            expires_at(state.clone(), hash.clone()).await,
            NOW + SESSION_TTL
        );

        // A few days later: still valid, and the expiry slides forward.
        let later = NOW + 3 * SESSION_REFRESH_INTERVAL;
        assert!(lookup(state.clone(), hash.clone(), later).await.is_some());
        assert_eq!(
            expires_at(state.clone(), hash.clone()).await,
            later + SESSION_TTL
        );

        // Past the expiry: gone.
        assert!(
            lookup(state.clone(), hash, later + SESSION_TTL)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn me_requires_a_valid_session() {
        let state = test_state();
        let app = router(state);
        for cookie in [None, Some("solenna_session=garbage"), Some("other=1")] {
            let response = send(&app, get("/api/me", cookie)).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{cookie:?}");
        }
    }

    #[tokio::test]
    async fn me_returns_only_the_session_owner() {
        let state = test_state();
        let alice = session_for(&state, "sub-a", "alice@example.com").await;
        let bob = session_for(&state, "sub-b", "bob@example.com").await;
        let app = router(state);

        for (cookie, email) in [(alice, "alice@example.com"), (bob, "bob@example.com")] {
            let response = send(&app, get("/api/me", Some(&cookie))).await;
            assert_eq!(response.status(), StatusCode::OK);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["email"], email);
        }
    }

    #[tokio::test]
    async fn start_redirects_to_google_with_pkce_and_state() {
        let app = router(test_state());
        let response = send(&app, get("/auth/google", None)).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);

        let url = Url::parse(location(&response)).unwrap();
        assert!(url.as_str().starts_with(GOOGLE_AUTH_URL));
        let param = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        assert_eq!(param("client_id"), "test-client-id");
        assert_eq!(
            param("redirect_uri"),
            "http://localhost:8080/auth/google/callback"
        );
        assert_eq!(param("code_challenge_method"), "S256");

        let cookies = set_cookies(&response);
        let oauth = &cookies[0];
        let value = oauth
            .strip_prefix("solenna_oauth=")
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let (state, verifier) = value.split_once('.').unwrap();
        assert_eq!(param("state"), state);
        assert_eq!(
            param("code_challenge"),
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
        assert!(oauth.contains("HttpOnly") && oauth.contains("SameSite=Lax"));
        assert!(!oauth.contains("Secure"), "plain http base URL");
    }

    #[tokio::test]
    async fn callback_rejects_bad_state_without_calling_google() {
        let app = router(test_state());
        let cases = [
            (
                "/auth/google/callback?code=c&state=wrong",
                Some("solenna_oauth=right.verifier"),
            ),
            ("/auth/google/callback?code=c&state=right", None),
            (
                "/auth/google/callback?state=right",
                Some("solenna_oauth=right.verifier"),
            ),
        ];
        for (uri, cookie) in cases {
            let response = send(&app, get(uri, cookie)).await;
            assert_eq!(
                location(&response),
                "/?auth_error=failed",
                "{uri} {cookie:?}"
            );
            assert!(
                !set_cookies(&response)
                    .iter()
                    .any(|c| c.starts_with("solenna_session=")),
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn callback_reports_cancelled_sign_in() {
        let app = router(test_state());
        let response = send(&app, get("/auth/google/callback?error=access_denied", None)).await;
        assert_eq!(location(&response), "/?auth_error=cancelled");
    }

    #[tokio::test]
    async fn logout_ends_the_session() {
        let state = test_state();
        let cookie = session_for(&state, "sub", "a@example.com").await;
        let app = router(state);

        let logout = |content_type: Option<&'static str>| {
            let mut request = Request::post("/auth/logout").header(header::COOKIE, &cookie);
            if let Some(content_type) = content_type {
                request = request.header(header::CONTENT_TYPE, content_type);
            }
            request.body(Body::from("{}")).unwrap()
        };

        // Not JSON: rejected (CSRF rule), session survives.
        let response = send(&app, logout(None)).await;
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let response = send(&app, get("/api/me", Some(&cookie))).await;
        assert_eq!(response.status(), StatusCode::OK);

        let response = send(&app, logout(Some("application/json"))).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(set_cookies(&response)[0].contains("Max-Age=0"));
        let response = send(&app, get("/api/me", Some(&cookie))).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn rate_limiter_blocks_after_max_in_window() {
        let limiter = RateLimiter::new(2, Duration::from_secs(60));
        assert!(limiter.check().is_ok());
        assert!(limiter.check().is_ok());
        assert!(matches!(limiter.check(), Err(AppError::RateLimited)));
    }

    #[tokio::test]
    async fn sign_in_start_and_logout_are_not_rate_limited() {
        // The limit (60/min in AppState) only guards the call to Google, so
        // hammering the cheap endpoints can't lock everyone out of signing in or out.
        let app = router(test_state());
        for _ in 0..100 {
            let response = send(&app, get("/auth/google", None)).await;
            assert_eq!(response.status(), StatusCode::SEE_OTHER);
        }
        let logout = Request::post("/auth/logout")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(send(&app, logout).await.status(), StatusCode::NO_CONTENT);
    }

    #[test]
    fn only_known_oauth_errors_are_logged_verbatim() {
        assert_eq!(known_oauth_error("access_denied"), Some("access_denied"));
        assert_eq!(known_oauth_error("evil\ninjected log line"), None);
    }

    #[test]
    fn cookies_are_secure_over_https() {
        assert!(cookie("a", "b", "/", 1, true).ends_with("; Secure"));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("x=1; solenna_session=abc; y=2"),
        );
        assert_eq!(
            read_cookie(&headers, SESSION_COOKIE).as_deref(),
            Some("abc")
        );
    }
}
