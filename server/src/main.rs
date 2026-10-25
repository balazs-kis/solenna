mod config;
mod error;
mod web;

use std::{io::IsTerminal, net::SocketAddr};

use axum::{
    Json, Router,
    http::{HeaderValue, header},
    middleware,
    response::Response,
    routing::{any, get},
};
use serde_json::{Value, json};

use crate::error::AppError;

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

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));
    tracing::info!("listening on port {}", config.port);

    axum::serve(listener, router())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

fn router() -> Router {
    Router::new()
        .route("/api/health", get(health))
        // `{*rest}` doesn't match an empty path, so `/api` and `/api/` need their own routes.
        .route("/api", any(api_not_found))
        .route("/api/", any(api_not_found))
        .route("/api/{*rest}", any(api_not_found))
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(web::static_handler)
        .layer(middleware::map_response(security_headers))
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

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
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
