use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// Every error response goes through this type, so clients always get
/// `{ "error": "<code>" }` with a matching status code.
#[derive(Debug)]
pub enum AppError {
    NotFound,
    MethodNotAllowed,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::MethodNotAllowed => (StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed"),
        };
        (status, Json(json!({ "error": code }))).into_response()
    }
}
