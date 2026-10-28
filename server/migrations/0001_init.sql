-- Users are found by the SHA-256 hash (hex) of Google's `sub`, never by email:
-- for personal accounts `sub` is the global Google ID, which public tools can
-- map to a person. No email, name or picture is stored; the browser keeps
-- those for display. `language` stays NULL until the user picks one (the
-- browser's language is used until then); it's checked against the available
-- languages in Rust, so adding a language needs no migration.
CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    sub_hash        TEXT NOT NULL UNIQUE,
    language        TEXT,
    track_cycle     INTEGER NOT NULL DEFAULT 1 CHECK (track_cycle IN (0, 1)),
    show_fertility  INTEGER NOT NULL DEFAULT 1 CHECK (show_fertility IN (0, 1)),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
) STRICT;

-- Only the SHA-256 hash of the session cookie token is stored.
CREATE TABLE sessions (
    token_hash  BLOB PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_user_id ON sessions(user_id);

-- One weigh-in per user per calendar day; saving the same day again replaces it.
-- `day` is the user's local date (YYYY-MM-DD), checked for real dates in Rust.
CREATE TABLE weights (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day         TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    weight_g    INTEGER NOT NULL CHECK (weight_g BETWEEN 20000 AND 400000),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
) STRICT, WITHOUT ROWID;

-- A period: bleeding from `start_day` to `end_day` (inclusive). `end_day` is NULL
-- while the period is ongoing. Periods of a user never overlap; an ongoing one
-- counts as open-ended, so it is always the latest (enforced in Rust).
CREATE TABLE periods (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_day   TEXT NOT NULL CHECK (start_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    end_day     TEXT CHECK (
                    end_day IS NULL
                    OR (end_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND end_day >= start_day)
                ),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (user_id, start_day)
) STRICT;

-- Bleeding strength per day of a period: 1 spotting, 2 light, 3 medium,
-- 4 heavy, 5 very heavy. Days without a row have no strength logged.
CREATE TABLE period_flow (
    period_id   INTEGER NOT NULL REFERENCES periods(id) ON DELETE CASCADE,
    day         TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    flow        INTEGER NOT NULL CHECK (flow BETWEEN 1 AND 5),
    PRIMARY KEY (period_id, day)
) STRICT, WITHOUT ROWID;
