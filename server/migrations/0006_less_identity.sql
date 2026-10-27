-- Store less identity. Users are found by a SHA-256 hash of Google's `sub`
-- (the account's global Google ID, which public tools can map to a person),
-- and the email, name and picture aren't kept at all: the browser keeps them
-- for display. `sha256()` is registered by db.rs. With secure_delete on, the
-- dropped values are overwritten in the file, not just marked as free.
UPDATE users SET google_sub = lower(hex(sha256(google_sub)));
ALTER TABLE users RENAME COLUMN google_sub TO sub_hash;
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users DROP COLUMN name;
ALTER TABLE users DROP COLUMN avatar;
ALTER TABLE users DROP COLUMN avatar_type;
