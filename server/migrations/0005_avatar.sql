-- The user's Google profile picture, downloaded at sign-in so the browser
-- never loads anything from Google. `avatar_type` is its MIME type, detected
-- from the bytes. Both are NULL when there's no picture.
ALTER TABLE users ADD COLUMN avatar BLOB;
ALTER TABLE users ADD COLUMN avatar_type TEXT;
