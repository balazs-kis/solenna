//! Google sign-in (OpenID Connect authorization code flow with PKCE) and sessions.
//!
//! Flow: `GET /auth/google` stores a random `state` and PKCE verifier in a
//! short-lived HttpOnly cookie and redirects to Google. Google redirects back to
//! `GET /auth/google/callback`, which checks `state`, exchanges the code for an
//! ID token, upserts the user and starts a session. Failures redirect to
//! `/?auth_error=cancelled|failed` for the frontend to show.

use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::{FromRequestParts, Query, State, rejection::QueryRejection},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{AppendHeaders, IntoResponse, Redirect, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
    AppState,
    avatar::{self, Avatar},
    config::Config,
    db::unix_now,
    error::AppError,
};

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

// Cookie names without their `__Host-` prefix (see `cookie_name`).
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
/// A user who signed in but never agreed to the privacy notice (and so has no
/// data) is deleted after this long.
const UNCONSENTED_USER_TTL: i64 = 24 * 60 * 60;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/google", get(start))
        .route("/auth/google/callback", get(callback))
        .route("/auth/logout", post(logout))
}

/// The signed-in user, who has agreed to the privacy notice. Use it as a
/// handler argument: before the handler runs, requests without a valid session
/// are rejected with 401, and users who haven't agreed yet with 403
/// `consent_required`. So no route stores or returns health data without
/// consent. Only the routes needed before agreeing take [`SignedIn`] instead.
pub struct CurrentUser {
    pub id: i64,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let user = SignedIn::from_request_parts(parts, state).await?;
        if !user.consented {
            return Err(AppError::Forbidden("consent_required"));
        }
        Ok(CurrentUser { id: user.id })
    }
}

/// Any signed-in user, whether or not they've agreed to the privacy notice yet
/// (401 without a valid session). Only for `GET /api/me`, giving consent, and
/// deleting the account (declining); everything else takes [`CurrentUser`].
pub struct SignedIn {
    pub id: i64,
    /// The hash of this session's token (picks up the session's `PendingProfiles` entry).
    pub session: Vec<u8>,
    pub consented: bool,
}

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let secure = state.config.secure_cookies();
        let token =
            read_cookie(&parts.headers, SESSION_COOKIE, secure).ok_or(AppError::Unauthorized)?;
        let hash = hash_token(&token);
        let now = unix_now();
        let session = hash.clone();
        let user = state
            .db
            .call(move |conn| lookup_session(conn, &hash, now))
            .await?;
        user.map(|(id, consented)| SignedIn {
            id,
            session,
            consented,
        })
        .ok_or(AppError::Unauthorized)
    }
}

/// How long a fresh sign-in's profile waits for the browser to pick it up.
const PROFILE_TTL: Duration = Duration::from_secs(10 * 60);
/// At most this many profiles wait at once (each can hold a picture of up to
/// 200 KB); a sign-in beyond it pushes out the oldest. Each user holds at most
/// one: signing in again replaces their waiting profile.
const MAX_PENDING_PROFILES: usize = 100;

/// The name, email and picture from Google, for display only.
pub struct Profile {
    pub name: String,
    pub email: String,
    pub avatar: Option<Avatar>,
}

/// The profiles of fresh sign-ins, by session hash. They're never written to
/// the database: they wait here, in memory, until that session's first
/// `GET /api/me` takes them (at most `PROFILE_TTL`), and the browser keeps them
/// from then on. A restart in between loses one, and the app shows a generic
/// "Google account" until the next sign-in.
#[derive(Default)]
pub struct PendingProfiles {
    profiles: Mutex<HashMap<Vec<u8>, Pending>>,
}

struct Pending {
    user_id: i64,
    added: Instant,
    profile: Profile,
}

impl PendingProfiles {
    fn insert(&self, session: Vec<u8>, user_id: i64, profile: Profile, now: Instant) {
        let mut profiles = self.profiles.lock().unwrap_or_else(PoisonError::into_inner);
        profiles.retain(|_, pending| {
            pending.user_id != user_id && now.duration_since(pending.added) < PROFILE_TTL
        });
        while profiles.len() >= MAX_PENDING_PROFILES {
            let oldest = profiles
                .iter()
                .min_by_key(|(_, pending)| pending.added)
                .map(|(session, _)| session.clone());
            match oldest {
                Some(session) => profiles.remove(&session),
                None => break,
            };
        }
        let pending = Pending {
            user_id,
            added: now,
            profile,
        };
        profiles.insert(session, pending);
    }

    /// The session's profile, once: it's gone from memory afterwards.
    pub fn take(&self, session: &[u8], now: Instant) -> Option<Profile> {
        let mut profiles = self.profiles.lock().unwrap_or_else(PoisonError::into_inner);
        let pending = profiles.remove(session)?;
        (now.duration_since(pending.added) < PROFILE_TTL).then_some(pending.profile)
    }
}

/// Users are found by this, not by `sub` itself: for personal Google accounts
/// `sub` is the account's global Google ID, which public tools can map to a
/// name and photo. So a stolen database can't be matched to people in bulk.
pub fn sub_hash(sub: &str) -> String {
    Sha256::digest(sub.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Fixed-window limit on the sign-in callback's call to Google, shared by
/// everyone: a per-IP limit would mean trusting `X-Forwarded-For` from the proxy.
/// It stops someone hammering Google's token endpoint through us. The price:
/// anyone can use up the window (with their own `state` cookie and made-up
/// codes), which blocks new sign-ins, not existing sessions, while they keep
/// it up. Without a limit they could hammer Google instead.
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
    params: Result<Query<CallbackParams>, QueryRejection>,
) -> Response {
    let secure = state.config.secure_cookies();
    let clear_oauth = cookie(OAUTH_COOKIE, "", 0, secure);

    let result = match params {
        Ok(Query(params)) => finish_login(&state, &headers, params).await,
        Err(_) => {
            tracing::warn!("sign-in callback with a malformed query");
            Err(LoginError::Failed)
        }
    };
    match result {
        Ok(token) => (
            AppendHeaders([
                (header::SET_COOKIE, clear_oauth),
                (
                    header::SET_COOKIE,
                    cookie(SESSION_COOKIE, &token, SESSION_COOKIE_MAX_AGE, secure),
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

    let secure = state.config.secure_cookies();
    let oauth_cookie = read_cookie(headers, OAUTH_COOKIE, secure).ok_or_else(|| {
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

    let profile = Profile {
        name: claims.name,
        email: claims.email,
        avatar: avatar::fetch(&state.http, claims.picture.as_deref()).await,
    };

    // Signing in again in this browser replaces its previous session.
    let previous = read_cookie(headers, SESSION_COOKIE, secure).map(|token| hash_token(&token));
    let sub = claims.sub;
    let (token, user_id) = state
        .db
        .call(move |conn| login_user(conn, &sub, now, previous))
        .await
        .map_err(|_| LoginError::Failed)?;
    state
        .profiles
        .insert(hash_token(&token), user_id, profile, Instant::now());
    Ok(token)
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
    #[serde(default)]
    email: String,
    #[serde(default)]
    name: String,
    /// URL of the profile picture (the `profile` scope), if the user has one.
    #[serde(default)]
    picture: Option<String>,
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

/// Creates the user on first sign-in and starts a session, ending `previous`
/// (the hash of the browser's old session, if any). Returns the session token
/// for the cookie (only its hash is stored) and the user's id. Nothing about who the user is gets
/// stored, only `sub_hash`.
fn login_user(
    conn: &mut Connection,
    sub: &str,
    now: i64,
    previous: Option<Vec<u8>>,
) -> Result<(String, i64), AppError> {
    let tx = conn.transaction()?;
    if let Some(previous) = previous {
        tx.execute("DELETE FROM sessions WHERE token_hash = ?", [previous])?;
    }
    // Housekeeping: someone who signed in but never agreed to the privacy
    // notice can't have stored anything; their row (and sessions) go after a
    // day. Before the upsert, so a returning user just starts over.
    tx.execute(
        "DELETE FROM users WHERE consented_at IS NULL AND created_at <= ?",
        [now - UNCONSENTED_USER_TTL],
    )?;
    let user_id: i64 = tx.query_row(
        "INSERT INTO users (sub_hash, created_at, updated_at) VALUES (?1, ?2, ?2)
         ON CONFLICT (sub_hash) DO UPDATE SET updated_at = excluded.updated_at
         RETURNING id",
        (sub_hash(sub), now),
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
    Ok((token, user_id))
}

/// Returns the session's user and whether they've agreed to the privacy
/// notice, extending the session if it is due.
fn lookup_session(
    conn: &Connection,
    hash: &[u8],
    now: i64,
) -> Result<Option<(i64, bool)>, AppError> {
    let session: Option<(i64, i64, bool)> = conn
        .query_row(
            "SELECT s.user_id, s.expires_at, u.consented_at IS NOT NULL
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ? AND s.expires_at > ?",
            (hash, now),
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((user_id, expires_at, consented)) = session else {
        return Ok(None);
    };

    if now + SESSION_TTL - expires_at >= SESSION_REFRESH_INTERVAL {
        conn.execute(
            "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
            (now + SESSION_TTL, hash),
        )?;
    }
    Ok(Some((user_id, consented)))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, AppError> {
    if let Some(token) = read_cookie(&headers, SESSION_COOKIE, state.config.secure_cookies()) {
        let hash = hash_token(&token);
        state
            .db
            .call(move |conn| {
                conn.execute("DELETE FROM sessions WHERE token_hash = ?", [hash])?;
                Ok(())
            })
            .await?;
    }
    Ok((
        AppendHeaders([(header::SET_COOKIE, clear_session_cookie(&state.config))]),
        StatusCode::NO_CONTENT,
    )
        .into_response())
}

/// A `Set-Cookie` value that removes the session cookie (logout, account deletion).
pub fn clear_session_cookie(config: &Config) -> String {
    cookie(SESSION_COOKIE, "", 0, config.secure_cookies())
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

/// Over https, cookie names get the `__Host-` prefix. The browser then only
/// accepts the cookie from this exact host, over https, with `Path=/` and no
/// `Domain`, so a site on a sibling subdomain can't plant its own session or
/// sign-in cookie here (cookie tossing) and sign the user into another account.
/// Plain http (local dev) can't use the prefix.
fn cookie_name(name: &str, secure: bool) -> String {
    if secure {
        format!("__Host-{name}")
    } else {
        name.to_string()
    }
}

/// Always `Path=/`: the `__Host-` prefix requires it.
fn cookie(name: &str, value: &str, max_age: i64, secure: bool) -> String {
    let name = cookie_name(name, secure);
    let secure = if secure { "; Secure" } else { "" };
    format!("{name}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}")
}

fn read_cookie(headers: &HeaderMap, name: &str, secure: bool) -> Option<String> {
    let name = cookie_name(name, secure);
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string())
}

/// Signs a user in directly (skipping Google), with `email` as their pending
/// profile, and returns a `Cookie` header value for the session. The user has
/// agreed to the privacy notice. For tests of any route that needs a session.
#[cfg(test)]
pub async fn test_session(state: &AppState, sub: &'static str, email: &'static str) -> String {
    let cookie = test_session_without_consent(state, sub, email).await;
    state
        .db
        .call(move |conn| {
            conn.execute(
                "UPDATE users SET consented_at = 1 WHERE sub_hash = ?",
                [sub_hash(sub)],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    cookie
}

/// Like `test_session`, for a user who hasn't agreed to the privacy notice yet.
#[cfg(test)]
pub async fn test_session_without_consent(
    state: &AppState,
    sub: &'static str,
    email: &'static str,
) -> String {
    let (token, user_id) = state
        .db
        .call(move |conn| login_user(conn, sub, unix_now(), None))
        .await
        .unwrap();
    let profile = Profile {
        name: String::new(),
        email: email.into(),
        avatar: None,
    };
    state
        .profiles
        .insert(hash_token(&token), user_id, profile, Instant::now());
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

        let (users, hash): (i64, String) = state
            .db
            .call(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*), MAX(sub_hash) FROM users", [], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?,
                )
            })
            .await
            .unwrap();
        // Only the hash is stored, never the sub itself.
        assert_eq!((users, hash), (1, sub_hash("sub-1")));
    }

    #[test]
    fn pending_profiles_are_capped() {
        let profiles = PendingProfiles::default();
        let now = Instant::now();
        for i in 0..=MAX_PENDING_PROFILES {
            let profile = Profile {
                name: String::new(),
                email: format!("{i}@example.com"),
                avatar: None,
            };
            let added = now + Duration::from_millis(i as u64);
            profiles.insert(i.to_le_bytes().to_vec(), i as i64, profile, added);
        }
        let later = now + Duration::from_secs(1);
        // The oldest made room; the newest is there.
        assert!(profiles.take(&0usize.to_le_bytes(), later).is_none());
        assert!(
            profiles
                .take(&MAX_PENDING_PROFILES.to_le_bytes(), later)
                .is_some()
        );
    }

    #[test]
    fn each_user_holds_one_pending_profile() {
        let profiles = PendingProfiles::default();
        let now = Instant::now();
        let profile = |email: &str| Profile {
            name: String::new(),
            email: email.into(),
            avatar: None,
        };
        profiles.insert(b"other".to_vec(), 2, profile("b@example.com"), now);
        // One user signing in over and over doesn't push anyone else out.
        for i in 0..(MAX_PENDING_PROFILES * 2) {
            profiles.insert(i.to_le_bytes().to_vec(), 1, profile("a@example.com"), now);
        }
        assert!(profiles.take(b"other", now).is_some());
        let last = (MAX_PENDING_PROFILES * 2 - 1).to_le_bytes();
        assert!(
            profiles.take(&last, now).is_some(),
            "the newest sign-in's profile"
        );
        assert!(
            profiles.take(&0usize.to_le_bytes(), now).is_none(),
            "replaced"
        );
    }

    #[tokio::test]
    async fn malformed_callback_query_redirects_with_an_error() {
        let app = router(test_state());
        let response = send(&app, get("/auth/google/callback?state=a&state=b", None)).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(location(&response), "/?auth_error=failed");
    }

    #[test]
    fn profiles_are_handed_over_once_and_expire() {
        let profiles = PendingProfiles::default();
        let profile = |email: &str| Profile {
            name: String::new(),
            email: email.into(),
            avatar: None,
        };
        let now = Instant::now();
        profiles.insert(b"a".to_vec(), 1, profile("a@example.com"), now);
        profiles.insert(b"b".to_vec(), 2, profile("b@example.com"), now);

        let taken = profiles.take(b"a", now).map(|p| p.email);
        assert_eq!(taken.as_deref(), Some("a@example.com"));
        assert!(profiles.take(b"a", now).is_none(), "only once");
        // Too late: the browser had PROFILE_TTL to pick it up.
        assert!(profiles.take(b"b", now + PROFILE_TTL).is_none());
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
                login_user(conn, "sub-2", unix_now(), Some(old_hash)).map(|(token, _)| token)
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
            .call(|conn| login_user(conn, "sub", NOW, None).map(|(token, _)| token))
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
    async fn users_who_never_agree_are_removed_after_a_day() {
        let state = test_state();
        let remaining = state
            .db
            .call(|conn| {
                login_user(conn, "never-agreed", NOW, None)?;
                login_user(conn, "agreed", NOW, None)?;
                conn.execute(
                    "UPDATE users SET consented_at = ? WHERE sub_hash = ?",
                    (NOW, sub_hash("agreed")),
                )?;
                // Just under a day later, everyone stays.
                login_user(conn, "late", NOW + UNCONSENTED_USER_TTL - 1, None)?;
                // A day later, the one who never agreed goes, with their session.
                login_user(conn, "later", NOW + UNCONSENTED_USER_TTL, None)?;
                let mut statement = conn.prepare("SELECT sub_hash FROM users ORDER BY id")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
            .await
            .unwrap();
        let expected: Vec<String> = ["agreed", "late", "later"].map(sub_hash).into();
        assert_eq!(remaining, expected);
        assert_eq!(session_count(&state).await, 3);
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

        // Each session's first /api/me gets that session's own profile, once.
        for (cookie, email) in [(alice, "alice@example.com"), (bob, "bob@example.com")] {
            for expected in [json!(email), Value::Null] {
                let response = send(&app, get("/api/me", Some(&cookie))).await;
                assert_eq!(response.status(), StatusCode::OK);
                let body: Value = serde_json::from_slice(
                    &to_bytes(response.into_body(), usize::MAX).await.unwrap(),
                )
                .unwrap();
                assert_eq!(body["profile"]["email"], expected);
            }
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
        assert_eq!(
            cookie(SESSION_COOKIE, "b", 1, true),
            "__Host-solenna_session=b; Path=/; Max-Age=1; HttpOnly; SameSite=Lax; Secure"
        );
        assert_eq!(
            cookie(SESSION_COOKIE, "b", 1, false),
            "solenna_session=b; Path=/; Max-Age=1; HttpOnly; SameSite=Lax"
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("x=1; solenna_session=abc; __Host-solenna_session=def; y=2"),
        );
        assert_eq!(
            read_cookie(&headers, SESSION_COOKIE, false).as_deref(),
            Some("abc")
        );
        // Over https, only the prefixed cookie counts: one without the prefix
        // may have been set by another subdomain.
        assert_eq!(
            read_cookie(&headers, SESSION_COOKIE, true).as_deref(),
            Some("def")
        );
    }
}
