//! Serves the static frontend from `web/`.
//!
//! In debug builds rust-embed reads files from disk on every request, so frontend
//! edits only need a browser refresh. Release builds embed the files in the binary.

use axum::{
    http::{Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::{EmbeddedFile, RustEmbed};

use crate::error::AppError;

#[derive(RustEmbed)]
#[folder = "../web/"]
struct Assets;

pub async fn static_handler(method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return AppError::MethodNotAllowed.into_response();
    }

    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(path) {
        return file_response(file);
    }

    // Paths without a file extension are app routes: serve the shell and let the
    // frontend router handle them. Missing files (e.g. /css/nope.css) stay 404.
    let last_segment = path.rsplit('/').next().unwrap_or_default();
    if !last_segment.contains('.')
        && let Some(index) = Assets::get("index.html")
    {
        return file_response(index);
    }

    StatusCode::NOT_FOUND.into_response()
}

fn file_response(file: EmbeddedFile) -> Response {
    (
        [
            (header::CONTENT_TYPE, file.metadata.mimetype().to_string()),
            // The service worker does the caching; always revalidate here.
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        file.data,
    )
        .into_response()
}
