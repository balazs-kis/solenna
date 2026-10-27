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
