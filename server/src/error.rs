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
    /// No valid session.
    Unauthorized,
    NotFound,
    MethodNotAllowed,
    /// State-changing request without `Content-Type: application/json`.
    UnsupportedMediaType,
    RateLimited,
    /// Something went wrong on our side. Log the details where the error is
    /// created; the client only ever sees `internal`.
    Internal,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::MethodNotAllowed => (StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed"),
            AppError::UnsupportedMediaType => {
                (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
            }
            AppError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            AppError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        (status, Json(json!({ "error": code }))).into_response()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        tracing::error!("database error: {}", describe_db_error(&e));
        AppError::Internal
    }
}

/// A log-safe description of a database error. Some rusqlite errors embed the
/// offending value (which could be health data), so only errors known to carry
/// no values are logged in full.
fn describe_db_error(e: &rusqlite::Error) -> String {
    use rusqlite::Error as E;
    match e {
        // SQLite's own messages name tables, columns and constraints, never bound values.
        E::SqliteFailure(..)
        | E::QueryReturnedNoRows
        | E::ExecuteReturnedResults
        | E::InvalidColumnIndex(_)
        | E::InvalidColumnName(_)
        | E::InvalidColumnType(..)
        | E::InvalidParameterCount(..)
        | E::InvalidParameterName(_) => e.to_string(),
        E::IntegralValueOutOfRange(column, _) => {
            format!("integral value out of range (column {column})")
        }
        E::FromSqlConversionFailure(column, ty, _) => {
            format!("conversion failure (column {column}, type {ty})")
        }
        _ => "rusqlite error (details withheld)".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_error_descriptions_do_not_leak_values() {
        let out_of_range = rusqlite::Error::IntegralValueOutOfRange(0, 73500);
        assert!(!describe_db_error(&out_of_range).contains("73500"));

        let conversion = rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            "bad value 73.5".into(),
        );
        assert!(!describe_db_error(&conversion).contains("73.5"));
    }
}
