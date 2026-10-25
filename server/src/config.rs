use std::{collections::HashMap, env, fs, path::PathBuf};

/// No `Debug`: it holds the OAuth client secret.
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    /// Public URL without a trailing slash, e.g. `https://solenna.example.com`.
    pub base_url: String,
    pub google_client_id: String,
    pub google_client_secret: String,
}

impl Config {
    /// Reads config from the environment, falling back to a `.env` file in the
    /// working directory (local dev). Real environment variables win; in the
    /// container compose passes everything as real variables.
    pub fn from_env() -> Result<Self, String> {
        let dotenv = fs::read_to_string(".env")
            .map(|contents| parse_dotenv(&contents))
            .unwrap_or_default();
        let var = |name: &str| {
            env::var(name)
                .ok()
                .or_else(|| dotenv.get(name).cloned())
                // Compose passes unset variables through as empty strings.
                .filter(|v| !v.is_empty())
        };
        let required = |name: &str| var(name).ok_or_else(|| format!("{name} is required"));

        let port = match var("SOLENNA_PORT") {
            Some(v) => v
                .parse()
                .map_err(|_| format!("SOLENNA_PORT is not a valid port: {v}"))?,
            None => 8080,
        };
        let data_dir = PathBuf::from(required("SOLENNA_DATA_DIR")?);

        let base_url = required("SOLENNA_BASE_URL")?
            .trim_end_matches('/')
            .to_string();
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(format!(
                "SOLENNA_BASE_URL must start with https:// or http://: {base_url}"
            ));
        }

        Ok(Self {
            port,
            data_dir,
            base_url,
            google_client_id: required("GOOGLE_CLIENT_ID")?,
            google_client_secret: required("GOOGLE_CLIENT_SECRET")?,
        })
    }

    /// Cookies get the `Secure` flag when the app is served over HTTPS. Local
    /// dev on plain `http://localhost` works without it.
    pub fn secure_cookies(&self) -> bool {
        self.base_url.starts_with("https://")
    }
}

/// Follows compose's env-file rules for the cases we use, so `cargo run` and
/// `docker compose` read the same `.env` the same way:
/// - blank lines and `#` comment lines are skipped; an `export ` prefix is allowed
/// - a quoted value is taken literally up to its closing quote (no escapes)
/// - in an unquoted value, `#` preceded by whitespace starts an inline comment;
///   a `#` inside a value (`ab#cd`) is kept
fn parse_dotenv(contents: &str) -> HashMap<String, String> {
    contents.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let line = line.strip_prefix("export ").unwrap_or(line);
    let (key, value) = line.split_once('=')?;
    let value = value.trim();

    let value = match value.chars().next() {
        Some(quote @ ('"' | '\'')) => match value[1..].find(quote) {
            Some(end) => &value[1..1 + end],
            None => value,
        },
        _ => value
            .char_indices()
            .find(|&(i, c)| c == '#' && value[..i].ends_with(char::is_whitespace))
            .map_or(value, |(i, _)| value[..i].trim_end()),
    };
    Some((key.trim().to_string(), value.to_string()))
}

#[cfg(test)]
impl Config {
    pub fn for_tests() -> Self {
        Self {
            port: 0,
            data_dir: PathBuf::from("."),
            base_url: "http://localhost:8080".to_string(),
            google_client_id: "test-client-id".to_string(),
            google_client_secret: "test-client-secret".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dotenv_like_compose() {
        let env = parse_dotenv(
            r#"
# comment line

PLAIN=value
SPACED = value with spaces
export EXPORTED=yes
INLINE=value # trailing comment
HASH_IN_VALUE=ab#cd
DOUBLE="quoted # not a comment"
SINGLE='single'  # comment after quotes
EQUALS=a=b=c
EMPTY=
UNTERMINATED="oops
no equals sign here
"#,
        );

        let expected = [
            ("PLAIN", "value"),
            ("SPACED", "value with spaces"),
            ("EXPORTED", "yes"),
            ("INLINE", "value"),
            ("HASH_IN_VALUE", "ab#cd"),
            ("DOUBLE", "quoted # not a comment"),
            ("SINGLE", "single"),
            ("EQUALS", "a=b=c"),
            ("EMPTY", ""),
            ("UNTERMINATED", "\"oops"),
        ];
        for (key, value) in expected {
            assert_eq!(env.get(key).map(String::as_str), Some(value), "{key}");
        }
        assert_eq!(env.len(), expected.len());
    }
}
