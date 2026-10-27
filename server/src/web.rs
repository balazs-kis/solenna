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

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet},
        fmt::Write,
        fs,
        path::{Path, PathBuf},
    };

    use sha2::{Digest, Sha256};

    fn web_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../web")
    }

    fn dictionary(lang: &str) -> BTreeMap<String, String> {
        let path = web_dir().join(format!("i18n/{lang}.json"));
        serde_json::from_str(&fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    fn js_sources(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                js_sources(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "js") {
                out.push((path.clone(), fs::read_to_string(&path).unwrap()));
            }
        }
    }

    /// Single-quoted literals shaped like a translation key (`section.name`),
    /// skipping comment lines.
    fn key_literals(source: &str) -> impl Iterator<Item = &str> {
        source
            .lines()
            .filter(|line| {
                let line = line.trim_start();
                !(line.starts_with("//") || line.starts_with("/*") || line.starts_with('*'))
            })
            .flat_map(|line| line.split('\'').skip(1).step_by(2))
            .filter(|literal| {
                let parts: Vec<&str> = literal.split('.').collect();
                parts.len() >= 2
                    && parts[0].starts_with(|c: char| c.is_ascii_lowercase())
                    && parts
                        .iter()
                        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
            })
    }

    fn placeholders(text: &str) -> BTreeSet<&str> {
        text.split('{')
            .skip(1)
            .filter_map(|rest| rest.split_once('}').map(|(name, _)| name))
            .collect()
    }

    /// Files in `dir`, as paths from the web root (`/js/app.js`).
    fn web_files(dir: &Path, out: &mut BTreeSet<String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                web_files(&path, out);
            } else {
                let relative = path.strip_prefix(web_dir()).unwrap();
                out.insert(format!(
                    "/{}",
                    relative.to_string_lossy().replace('\\', "/")
                ));
            }
        }
    }

    /// Installed apps only update when sw.js changes, so its VERSION is a hash
    /// of everything in web/ (sw.js without its VERSION line included).
    #[test]
    fn service_worker_version_matches_web_files() {
        let mut files = BTreeSet::new();
        web_files(&web_dir(), &mut files);
        let mut hasher = Sha256::new();
        for file in &files {
            let content = fs::read(web_dir().join(&file[1..])).unwrap();
            let content = if file == "/sw.js" {
                let text = String::from_utf8(content).unwrap();
                let lines: Vec<&str> = text
                    .lines()
                    .filter(|line| !line.starts_with("const VERSION"))
                    .collect();
                lines.join("\n").into_bytes()
            } else {
                content
            };
            hasher.update(file.as_bytes());
            hasher.update((content.len() as u64).to_le_bytes());
            hasher.update(&content);
        }
        let version = hasher.finalize()[..6]
            .iter()
            .fold(String::new(), |mut hex, byte| {
                let _ = write!(hex, "{byte:02x}");
                hex
            });

        let sw = fs::read_to_string(web_dir().join("sw.js")).unwrap();
        let expected = format!("const VERSION = '{version}';");
        assert!(
            sw.lines().any(|line| line == expected),
            "web/ changed: set `{expected}` in web/sw.js"
        );
    }

    #[test]
    fn service_worker_caches_every_web_file() {
        let sw = fs::read_to_string(web_dir().join("sw.js")).unwrap();
        let shell = sw
            .split("const SHELL = [")
            .nth(1)
            .unwrap()
            .split("];")
            .next()
            .unwrap();
        let listed: BTreeSet<String> = shell
            .lines()
            .map(|line| line.trim().trim_end_matches(',').trim_matches('\''))
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect();

        let mut files = BTreeSet::new();
        web_files(&web_dir(), &mut files);
        files.remove("/sw.js");
        assert_eq!(
            listed, files,
            "SHELL in web/sw.js must list every file in web/"
        );
    }

    #[test]
    fn server_knows_every_dictionary() {
        let mut files: Vec<String> = fs::read_dir(web_dir().join("i18n"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .map(|path| path.file_stem().unwrap().to_string_lossy().into_owned())
            .collect();
        files.sort();
        assert_eq!(
            files,
            crate::api::me::LANGUAGES,
            "update api::me::LANGUAGES"
        );
    }

    #[test]
    fn translations_are_complete_and_in_sync() {
        let en = dictionary("en");
        let hu = dictionary("hu");

        let en_keys: BTreeSet<_> = en.keys().collect();
        let hu_keys: BTreeSet<_> = hu.keys().collect();
        assert_eq!(
            en_keys, hu_keys,
            "en.json and hu.json must have the same keys"
        );

        for (key, text) in &en {
            assert!(!text.is_empty() && !hu[key].is_empty(), "{key}: empty text");
            assert_eq!(
                placeholders(text),
                placeholders(&hu[key]),
                "{key}: placeholders differ"
            );
        }

        let mut sources = Vec::new();
        js_sources(&web_dir().join("js"), &mut sources);
        let mut used = BTreeSet::new();
        for (path, source) in &sources {
            for key in key_literals(source) {
                assert!(
                    en.contains_key(key),
                    "{}: unknown translation key '{key}'",
                    path.display()
                );
                used.insert(key.to_string());
            }
        }

        let unused: Vec<_> = en.keys().filter(|key| !used.contains(*key)).collect();
        assert!(
            unused.is_empty(),
            "translation keys not used in web/js: {unused:?}"
        );
    }
}
