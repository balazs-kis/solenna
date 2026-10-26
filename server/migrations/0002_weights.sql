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
