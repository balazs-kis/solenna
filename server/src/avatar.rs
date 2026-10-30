//! The user's Google profile picture. It's downloaded at sign-in and handed to
//! the browser with the rest of the profile (see `PendingProfiles` in auth.rs),
//! so the browser never loads anything from Google and Google never sees when
//! the app is opened. It's never stored in the database.

use std::time::Duration;

use reqwest::Url;

/// Google resizes pictures on request. The largest avatar is 72 CSS px (the
/// Account header); over 5x that covers any phone screen's device pixels per CSS px.
const SIZE_PX: u32 = 384;
/// A 384px JPEG is usually 25–50 KB; anything far bigger isn't what we asked for.
const MAX_BYTES: usize = 200 * 1024;
/// Sign-in waits for the download, so keep it short. On timeout there's just no picture.
const TIMEOUT: Duration = Duration::from_secs(5);

pub struct Avatar {
    pub bytes: Vec<u8>,
    /// Detected from the bytes: `image/jpeg`, `image/png` or `image/webp`.
    pub content_type: &'static str,
}

impl Avatar {
    /// As a `data:` URL, for an `<img src>` (the CSP allows `img-src data:`).
    pub fn data_url(&self) -> String {
        use base64::{Engine, engine::general_purpose::STANDARD};
        format!(
            "data:{};base64,{}",
            self.content_type,
            STANDARD.encode(&self.bytes)
        )
    }
}

/// Downloads the picture from the ID token's `picture` claim. Never fails the
/// sign-in: problems are logged (without the URL), and the app shows the
/// monogram instead.
pub async fn fetch(http: &reqwest::Client, picture: Option<&str>) -> Option<Avatar> {
    let url = sized_url(picture?).or_else(|| {
        tracing::warn!("ignoring profile picture with an unexpected URL");
        None
    })?;
    download(http, url)
        .await
        .inspect_err(|reason| tracing::warn!("profile picture download failed: {reason}"))
        .ok()
}

/// Only https URLs on Google's picture host are fetched. Current ones end in a
/// size option like `=s96-c`, which is replaced with ours. Others (an older
/// format sized by a query string) are fetched as they are.
fn sized_url(picture: &str) -> Option<Url> {
    let mut url = Url::parse(picture).ok()?;
    let google_host = url
        .host_str()
        .is_some_and(|host| host.ends_with(".googleusercontent.com"));
    if url.scheme() != "https" || !google_host {
        return None;
    }
    if let Some((base, _size)) = url.path().split_once('=') {
        let path = format!("{base}=s{SIZE_PX}-c");
        url.set_path(&path);
    }
    Some(url)
}

/// Error texts are fixed strings: reqwest's errors contain the URL.
async fn download(http: &reqwest::Client, url: Url) -> Result<Avatar, &'static str> {
    let mut response = http
        .get(url)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|_| "request failed")?;
    if !response.status().is_success() {
        return Err("unexpected status");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "read failed")? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BYTES {
            return Err("too large");
        }
    }
    let content_type = image_type(&bytes).ok_or("not an image")?;
    Ok(Avatar {
        bytes,
        content_type,
    })
}

/// The image format from its first bytes. We serve the picture with this type,
/// so it's checked here rather than trusted from the response header.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_google_for_our_size() {
        let cases = [
            (
                "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c",
                "https://lh3.googleusercontent.com/a/ACg8ocK=s384-c",
            ),
            (
                "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c?x=1",
                "https://lh3.googleusercontent.com/a/ACg8ocK=s384-c?x=1",
            ),
            // No size suffix: left alone.
            (
                "https://lh3.googleusercontent.com/a/ACg8ocK",
                "https://lh3.googleusercontent.com/a/ACg8ocK",
            ),
            (
                "https://lh5.googleusercontent.com/-abc/photo.jpg?sz=50",
                "https://lh5.googleusercontent.com/-abc/photo.jpg?sz=50",
            ),
        ];
        for (picture, expected) in cases {
            assert_eq!(sized_url(picture).unwrap().as_str(), expected, "{picture}");
        }
    }

    #[test]
    fn only_fetches_from_googles_picture_host() {
        for picture in [
            "http://lh3.googleusercontent.com/a/x",
            "https://example.com/a/x",
            "https://googleusercontent.com.example.com/a/x",
            "https://lh3.googleusercontent.com.evil/a/x",
            "https://127.0.0.1/a/x",
            "not a url",
        ] {
            assert!(sized_url(picture).is_none(), "{picture}");
        }
    }

    #[test]
    fn detects_image_types_from_bytes() {
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"<svg xmlns="), None);
        assert_eq!(image_type(b"<html>"), None);
        assert_eq!(image_type(b""), None);
    }
}
