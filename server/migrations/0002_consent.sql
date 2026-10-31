-- When the user agreed to the privacy notice: explicit consent to storing
-- their health data (GDPR Art. 9(2)(a)), as Unix seconds. NULL until then, and
-- such a user can't store anything yet, so the rest of the app can assume an
-- unconsented user has no data (see CLAUDE.md, "Consent before any data").
ALTER TABLE users ADD COLUMN consented_at INTEGER;
