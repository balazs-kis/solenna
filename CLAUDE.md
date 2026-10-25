# Solenna

A simple weight and menstrual cycle tracking PWA. It works on phones (installable) and has a proper desktop layout. It is self-hosted as a single Docker image on a Debian server, configured through a compose file.

The whole codebase is written by AI. Optimize for **simplicity and readability**, not for abstraction. If a choice is between "clever" and "obvious", pick obvious.

**This repo is public on GitHub.** Never commit secrets, real user data, database files, or personal server details.

## Stack

| Layer    | Choice                                                         |
|----------|----------------------------------------------------------------|
| Frontend | Plain HTML, CSS, JavaScript (native ES modules). No build step. |
| Backend  | Rust: `axum` + `tokio`                                         |
| Database | SQLite via `rusqlite` (`bundled` feature). Raw SQL, no ORM.    |
| Auth     | Google OAuth 2.0 / OpenID Connect, hand-rolled with `reqwest`  |
| Deploy   | One static binary with the frontend embedded, one container   |

### Non-goals: do not introduce
- JS frameworks (React, Vue, Svelte, etc.), bundlers, transpilers, TypeScript, `package.json`, `node_modules`
- CSS frameworks that need a build step (Tailwind, Sass, etc.)
- ORMs or query builders
- Third-party scripts, fonts, or CDNs loaded at runtime. Everything is served from our own origin.
- Analytics, tracking, or telemetry of any kind

### Dependency policy
Keep direct dependencies minimal. The expected Rust crates are: `axum`, `tokio`, `tower-http`, `serde`, `serde_json`, `rusqlite`, `reqwest` (with `rustls-tls`, no OpenSSL), `rust-embed`, `rand`, `sha2`, `base64`, `time`, `tracing` + `tracing-subscriber`. Adding anything else needs a one-line justification in the commit message, and it must be something that is hard to write correctly ourselves. A small frontend library may be vendored into `web/vendor/` only if it clearly earns its place. Never pull one from a CDN.

## Repo layout

```
server/            Rust crate
  src/
    main.rs        startup, config, router
    config.rs      env var parsing
    db.rs          connection setup, migration runner
    auth.rs        Google OAuth flow, sessions, auth extractor
    api/           one module per resource (weights.rs, cycles.rs, me.rs, ...)
    error.rs       AppError -> HTTP response
  migrations/      0001_init.sql, 0002_....sql (embedded with include_str!)
web/               static frontend, served as-is
  index.html
  manifest.webmanifest
  sw.js
  css/
  js/
    app.js         entry point, router
    api.js         fetch wrapper
    store.js       state + subscribe
    i18n.js        t() + language selection
    views/         one module per screen
  i18n/
    en.js
    hu.js
  icons/
Dockerfile
compose.yaml
.env.example       placeholder values only
```

## Backend conventions

- **SQL lives inline** in the Rust functions that use it, as plain string literals. Use `?` parameters every time. Never build SQL with `format!`.
- **Every query that touches user data must filter by `user_id`.** User IDs come from the authenticated session, never from the request body or URL. This is the single most important rule in the codebase.
- **Migrations:** numbered `.sql` files in `server/migrations/`, embedded with `include_str!`, applied in order on startup and tracked with `PRAGMA user_version`. Never edit a migration that has been committed. Add a new one.
- **SQLite settings on every connection:** `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY` (the `scratch` image has no writable `/tmp` for SQLite temp files).
- **Data types:**
  - Weight is stored as `INTEGER` grams (`weight_g`). The UI shows kg with one decimal place.
  - Calendar days (weigh-ins, period days) are `TEXT` in `YYYY-MM-DD` format and represent the user's local date. Do not convert them to UTC.
  - Timestamps (created/updated, sessions) are `INTEGER` Unix seconds, UTC.
- **API:** JSON over `/api/*`. Use plain REST-ish routes. Errors go through `AppError` and return `{ "error": "<code>" }` with the right status code. Never leak internal error text to the client.
- **Async + rusqlite:** run DB work inside `tokio::task::spawn_blocking`. Keep it simple: one shared connection behind a `Mutex` is fine at this scale.
- **Lints:** code must pass `cargo fmt` and `cargo clippy -- -D warnings`. Avoid `unwrap()` outside of startup and tests.

## Auth

- Google OIDC **authorization code flow**, done server-side, with `state` + PKCE. Routes: `GET /auth/google` → Google → `GET /auth/google/callback`.
- Read the ID token from the token endpoint response (it comes back over TLS directly from Google). Check `iss`, `aud`, and `exp`. Identify users by the **`sub` claim**, never by email. Store the email and name for display only.
- **Open signup:** any Google account can sign in, and a user row is created on first login.
- **Sessions:** a random 32-byte token sent to the browser as a cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`). The DB stores only the **SHA-256 hash** of the token. Sessions expire (30 days, sliding).
- **CSRF:** `SameSite=Lax`, and every state-changing API request must be `Content-Type: application/json`. Reject anything else.
- `POST /auth/logout` deletes the session row.

## Privacy and security

This app stores health data. Treat it accordingly.

- Logs must never contain health values, tokens, cookies, or OAuth codes. Logging user IDs and routes is fine.
- Users can **export all their data** (JSON) and **delete their account**, which hard-deletes all their rows.
- Set security headers on every response: a strict CSP (`default-src 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`.
- Rate-limit the auth endpoints.
- HTTPS is terminated by a reverse proxy in front of the container. The app itself speaks plain HTTP and trusts `SOLENNA_BASE_URL` for building redirect URLs.

## Frontend conventions

- **No build step.** Files in `web/` are served exactly as written. Use `<script type="module">` and relative imports.
- **One rendering pattern, used everywhere:** state lives in `store.js`. Each view exports `render(container, state)`, which rebuilds its subtree from state. User actions call `api.js`, update the store, and the store re-renders. Don't hand-patch individual DOM nodes from event handlers.
- **XSS:** never put user-provided or API data into `innerHTML`. Build elements with `document.createElement` / `textContent`, or the small `h()` helper in `js/dom.js`.
- **i18n:** English and Hungarian. Every user-visible string goes through `t('key')`. No hardcoded UI text. Dictionaries are flat key → string objects in `web/i18n/en.js` and `hu.js`, and both must always have the same keys. Language comes from the user setting, falling back to `navigator.language`, then English. Format dates and numbers with `Intl`, using the active locale.
- **CSS:** modern plain CSS (custom properties, nesting, grid, container queries). Design mobile-first. Desktop gets a wider layout through media/container queries, not a separate UI. Theme colors are defined as custom properties on `:root`, and dark mode is supported via `prefers-color-scheme`.
- **Accessibility:** semantic HTML, real `<button>`s and `<label>`s, visible focus styles, and touch targets of at least 44px.

### PWA / offline
- Offline support covers the **app shell only**. The app opens offline and shows the last data it fetched, but saving requires a connection. Show a clear offline state and disable save buttons while offline.
- `sw.js` caches the static shell (cache-first) and never caches `/api/*` responses (always network).
- `sw.js` has a `VERSION` constant. **Bump it whenever any file in `web/` changes**, or users will be stuck on stale files.

## Config

All configuration comes from environment variables set in `compose.yaml` / `.env`:

| Variable               | Purpose                                          |
|------------------------|--------------------------------------------------|
| `SOLENNA_BASE_URL`     | Public URL, e.g. `https://solenna.example.com`   |
| `SOLENNA_DATA_DIR`     | Directory for the SQLite file (a mounted volume) |
| `SOLENNA_PORT`         | Listen port (default `8080`)                     |
| `GOOGLE_CLIENT_ID`     | OAuth client ID                                  |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret                              |

`.env` is gitignored. `.env.example` is committed with placeholder values only. The app fails fast on startup if a required variable is missing.

For local dev, the app also reads `./.env` from the working directory, so `cargo run` from the repo root just works. Real environment variables take precedence. The parser follows compose's env-file rules for comments, quotes and `export`, so both read the file the same way.

## Build and deploy

- **Dev:** `cargo run` serves `web/` from disk, so frontend edits need only a browser refresh.
- **Release:** `web/` is embedded into the binary with `rust-embed`.
- **Dockerfile:** multi-stage, using `cargo-chef` for dependency caching. It builds on `rust:<version>-alpine`, which produces a static musl binary natively for the host architecture, and runs it on `scratch` as uid 10001. TLS uses rustls with bundled roots, so no system CA certificates are needed. Keep the builder image version at or above `rust-version` in `server/Cargo.toml`.
- The SQLite file lives on a volume mounted at `SOLENNA_DATA_DIR`. It is the only state.

## Testing

- Use `cargo test` for backend logic and API handlers, run against an in-memory SQLite database with migrations applied.
- Every API resource gets at least one test proving **user A cannot read or modify user B's data**.
- Frontend: no test framework. Keep logic out of views where practical so it stays simple to reason about.
