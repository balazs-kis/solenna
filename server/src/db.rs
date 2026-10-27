//! SQLite connection setup and the migration runner.
//!
//! One connection, shared behind a mutex. All DB work runs on the blocking
//! thread pool via [`Db::call`], so it never stalls the async runtime.

use std::{
    path::Path,
    sync::{Arc, Mutex, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, functions::FunctionFlags};
use sha2::{Digest, Sha256};

use crate::error::AppError;

/// Applied in order. The DB's `PRAGMA user_version` is the number already applied.
/// Migrations land together with the code that uses them. Never edit a committed
/// migration; add a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_weights.sql"),
    include_str!("../migrations/0003_periods.sql"),
    include_str!("../migrations/0004_settings.sql"),
    include_str!("../migrations/0005_avatar.sql"),
    include_str!("../migrations/0006_less_identity.sql"),
];

/// Current time as Unix seconds (UTC), the format of every timestamp column.
pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::setup(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Self {
        Self::setup(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn setup(mut conn: Connection) -> Result<Self, String> {
        configure(&conn).map_err(|e| format!("configuring connection: {e}"))?;
        migrate(&mut conn, MIGRATIONS)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Runs `f` with the connection on the blocking thread pool.
    pub async fn call<T, F>(&self, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&mut Connection) -> Result<T, AppError> + Send + 'static,
        T: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            // A panic while holding the lock poisons it, but the connection itself
            // is still usable (an unfinished transaction is rolled back on drop).
            let mut conn = conn.lock().unwrap_or_else(PoisonError::into_inner);
            f(&mut conn)
        })
        .await
        .map_err(|e| {
            tracing::error!("database task failed: {e}");
            AppError::Internal
        })?
    }
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    // journal_mode returns the resulting mode as a row ("memory" for in-memory DBs).
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    // The scratch image has no writable /tmp for SQLite temp files.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    // Deleted rows are overwritten with zeros instead of lingering in free
    // pages, so a copy of the file doesn't contain deleted accounts' data.
    conn.pragma_update(None, "secure_delete", "ON")?;
    // sha256(text) -> blob, for migrations (SQLite has no hash function).
    conn.create_scalar_function(
        "sha256",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| Ok(Sha256::digest(ctx.get::<String>(0)?.as_bytes()).to_vec()),
    )?;
    Ok(())
}

fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn migrate(conn: &mut Connection, migrations: &[&str]) -> Result<(), String> {
    let applied = schema_version(conn).map_err(|e| format!("reading schema version: {e}"))?;
    let latest = migrations.len() as i64;

    if applied > latest {
        return Err(format!(
            "database schema version {applied} is newer than this app supports ({latest})"
        ));
    }

    for (index, sql) in migrations.iter().enumerate().skip(applied as usize) {
        let version = index as i64 + 1;
        // user_version lives in the DB header and is transactional, so a failed
        // migration leaves both the schema and the version untouched.
        let tx = conn
            .transaction()
            .map_err(|e| format!("migration {version} failed: {e}"))?;
        tx.execute_batch(sql)
            .and_then(|()| tx.pragma_update(None, "user_version", version))
            .and_then(|()| tx.commit())
            .map_err(|e| format!("migration {version} failed: {e}"))?;
        tracing::info!("applied database migration {version}");
    }
    if applied < latest {
        // Migrations can rewrite tables; empty the WAL so no copy of the old
        // pages stays behind in it.
        conn.pragma_update_and_check(None, "wal_checkpoint", "TRUNCATE", |_| Ok(()))
            .map_err(|e| format!("checkpoint after migrations: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CREATE_A: &str = "CREATE TABLE a (x INTEGER) STRICT;";
    const CREATE_B: &str = "CREATE TABLE b (x INTEGER) STRICT;";

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
            == 1
    }

    #[test]
    fn fresh_database_is_at_latest_version() {
        let db = Db::open_in_memory();
        let conn = db.conn.lock().unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn connection_pragmas_are_set() {
        let db = Db::open_in_memory();
        let conn = db.conn.lock().unwrap();
        let pragma = |name: &str| -> i64 {
            conn.pragma_query_value(None, name, |row| row.get(0))
                .unwrap()
        };
        assert_eq!(pragma("foreign_keys"), 1);
        assert_eq!(pragma("busy_timeout"), 5000);
        assert_eq!(pragma("temp_store"), 2, "2 = MEMORY");
        assert_eq!(pragma("secure_delete"), 1);
    }

    #[test]
    fn applies_pending_migrations_in_order() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, &[CREATE_A, CREATE_B]).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 2);
        assert!(table_exists(&conn, "a") && table_exists(&conn, "b"));
    }

    #[test]
    fn only_new_migrations_run() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, &[CREATE_A]).unwrap();
        // Re-running CREATE_A would fail with "table a already exists".
        migrate(&mut conn, &[CREATE_A, CREATE_B]).unwrap();
        migrate(&mut conn, &[CREATE_A, CREATE_B]).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 2);
    }

    #[test]
    fn failed_migration_is_rolled_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        let broken = "CREATE TABLE b (x INTEGER) STRICT; NOT VALID SQL;";
        let err = migrate(&mut conn, &[CREATE_A, broken]).unwrap_err();
        assert!(err.contains("migration 2 failed"), "{err}");
        assert_eq!(schema_version(&conn).unwrap(), 1);
        assert!(table_exists(&conn, "a"));
        assert!(!table_exists(&conn, "b"));
    }

    #[test]
    fn refuses_database_newer_than_app() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        let err = migrate(&mut conn, &[CREATE_A]).unwrap_err();
        assert!(err.contains("newer"), "{err}");
    }

    #[test]
    fn deleting_user_deletes_their_sessions() {
        let db = Db::open_in_memory();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO users (id, sub_hash, created_at, updated_at) VALUES (1, 'hash', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 1, 0, 0)",
            [b"hash".as_slice()],
        )
        .unwrap();

        conn.execute("DELETE FROM users WHERE id = 1", []).unwrap();

        let sessions: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(sessions, 0);
    }

    #[test]
    fn migration_6_hashes_the_sub_and_drops_identity() {
        let mut conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        migrate(&mut conn, &MIGRATIONS[..5]).unwrap();
        conn.execute(
            "INSERT INTO users (google_sub, email, name, avatar, avatar_type, created_at, updated_at)
             VALUES ('1234567890', 'a@example.com', 'A', x'FFD8FF', 'image/jpeg', 0, 0)",
            [],
        )
        .unwrap();

        migrate(&mut conn, MIGRATIONS).unwrap();
        let hash: String = conn
            .query_row("SELECT sub_hash FROM users", [], |row| row.get(0))
            .unwrap();
        assert_eq!(hash, crate::auth::sub_hash("1234567890"));
        let columns: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('users')")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for gone in ["google_sub", "email", "name", "avatar", "avatar_type"] {
            assert!(!columns.iter().any(|c| c == gone), "{gone} still exists");
        }
    }

    #[tokio::test]
    async fn call_runs_queries_and_returns_results() {
        let db = Db::open_in_memory();
        let value: i64 = db
            .call(|conn| Ok(conn.query_row("SELECT 41 + 1", [], |row| row.get(0))?))
            .await
            .unwrap();
        assert_eq!(value, 42);
    }
}
