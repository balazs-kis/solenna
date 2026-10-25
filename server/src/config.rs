use std::env;

pub struct Config {
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let port = match var("SOLENNA_PORT") {
            Some(v) => v
                .parse()
                .map_err(|_| format!("SOLENNA_PORT is not a valid port: {v}"))?,
            None => 8080,
        };
        Ok(Self { port })
    }
}

/// Reads an env var, treating an empty value as unset (compose passes unset
/// variables through as empty strings).
fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.is_empty())
}
