-- Per-user settings. `language` stays NULL until the user picks one; until
-- then the browser's language is used. It's checked against the available
-- languages in Rust, so adding a language needs no migration.
ALTER TABLE users ADD COLUMN language TEXT;
ALTER TABLE users ADD COLUMN track_cycle INTEGER NOT NULL DEFAULT 1 CHECK (track_cycle IN (0, 1));
ALTER TABLE users ADD COLUMN show_fertility INTEGER NOT NULL DEFAULT 1 CHECK (show_fertility IN (0, 1));
