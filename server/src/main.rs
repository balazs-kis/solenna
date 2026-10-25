mod config;
mod db;
mod error;
mod web;

use std::{io::IsTerminal, net::SocketAddr};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderValue, header},
    middleware,
    response::Response,
    routing::{any, get},
};
use serde_json::{Value, json};

use crate::{db::Db, error::AppError};

#[derive(Clone)]
struct AppState {
    db: Db,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_target(false)
        // No color codes when output goes to `docker logs` or a file.
        .with_ansi(std::io::stdout().is_terminal())
        .init();

    let config = config::Config::from_env().unwrap_or_else(|e| {
        eprintln!("config error: {e}");
        std::process::exit(1);
    });

    if let Err(e) = std::fs::create_dir_all(&config.data_dir) {
        eprintln!("cannot create {}: {e}", config.data_dir.display());
        std::process::exit(1);
    }
    let db = Db::open(&config.data_dir.join("solenna.db")).unwrap_or_else(|e| {
        eprintln!("database error: {e}");
        std::process::exit(1);
    });
    let state = AppState { db };

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    tracing::info!("listening on port {}", config.port);

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        // `{*rest}` doesn't match an empty path, so `/api` and `/api/` need their own routes.
        .route("/api", any(api_not_found))
        .route("/api/", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(web::static_handler)
        .layer(middleware::map_response(security_headers))
        .with_state(state)
}

/// Security headers required on every response.
async fn security_headers(mut res: Response) -> Response {
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    res
}

/// Also checks that the database answers.
async fn health(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    state
        .db
        .call(|conn| Ok(conn.query_row("SELECT 1", [], |_| Ok(()))?))
        .await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn api_not_found() -> AppError {
    AppError::NotFound
}

async fn method_not_allowed() -> AppError {
    AppError::MethodNotAllowed
}

/// Resolves on Ctrl+C, or SIGTERM on Unix (what `docker stop` sends).
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{HeaderMap, Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::*;

    async fn send(method: &str, uri: &str) -> (StatusCode, HeaderMap, Value) {
        let app = router(AppState {
            db: Db::open_in_memory(),
        });
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, headers, json)
    }

    #[tokio::test]
    async fn health_reports_ok() {
        let (status, _, body) = send("GET", "/api/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({ "status": "ok" }));
    }

    #[tokio::test]
    async fn unknown_api_paths_are_json_404() {
        for uri in ["/api", "/api/", "/api/nope", "/api/a/b"] {
            let (status, _, body) = send("GET", uri).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(body, json!({ "error": "not_found" }), "{uri}");
        }
    }

    #[tokio::test]
    async fn wrong_method_is_json_405() {
        for uri in ["/api/health", "/some/page"] {
            let (status, _, body) = send("POST", uri).await;
            assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED, "{uri}");
            assert_eq!(body, json!({ "error": "method_not_allowed" }), "{uri}");
        }
    }

    #[tokio::test]
    async fn security_headers_are_on_every_response() {
        for uri in ["/", "/api/health", "/api/nope", "/missing.css"] {
            let (_, headers, _) = send("GET", uri).await;
            for name in [
                header::CONTENT_SECURITY_POLICY,
                header::X_CONTENT_TYPE_OPTIONS,
                header::REFERRER_POLICY,
            ] {
                assert!(headers.contains_key(&name), "{uri} missing {name}");
            }
        }
    }
}
