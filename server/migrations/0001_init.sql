-- Users are identified by Google's stable `sub` claim; email and name are for display only.
CREATE TABLE users (
    id          INTEGER PRIMARY KEY,
    google_sub  TEXT NOT NULL UNIQUE,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;

-- Only the SHA-256 hash of the session cookie token is stored.
CREATE TABLE sessions (
    token_hash  BLOB PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_user_id ON sessions(user_id);
