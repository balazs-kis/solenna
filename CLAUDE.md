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
Keep direct dependencies minimal. The expected Rust crates are: `axum`, `tokio`, `tower-http`, `serde`, `serde_json`, `rusqlite`, `reqwest` (`default-features = false`, features `rustls`, `json`, `form`; no OpenSSL), `rust-embed`, `getrandom`, `sha2`, `base64`, `tracing` + `tracing-subscriber`. Dev-only: `tower` (`ServiceExt::oneshot` for router tests). Adding anything else needs a one-line justification in the commit message, and it must be something that is hard to write correctly ourselves. A small frontend library may be vendored into `web/vendor/` only if it clearly earns its place. Never pull one from a CDN.

## Repo layout

```
server/            Rust crate
  src/
    main.rs        startup, config, router
    config.rs      env var parsing
    db.rs          connection setup, migration runner
    auth.rs        Google OAuth flow, sessions, auth extractor
    avatar.rs      downloads the Google profile picture at sign-in
    api/           one module per resource (weights.rs, periods.rs, me.rs, ...)
    error.rs       AppError -> HTTP response
  migrations/      0001_init.sql, 0002_....sql (embedded with include_str!)
web/               static frontend, served as-is
  index.html
  favicon.ico      generated (see design/)
  manifest.webmanifest
  sw.js
  css/
  js/
    app.js         entry point, path → view map, nav, render
    router.js      HOME, navigate(), link interception
    api.js         fetch wrapper
    dom.js         h() / svg() element helpers
    format.js      calendar-day math, Intl date / day-count / kg formatting
    cycle-math.js  cycle predictions (pure functions, no DOM)
    store.js       state + subscribe
    snapshot.js    this device's copy of the user's data, for offline
    i18n.js        t() + language selection
    theme.js       theme setting (System / Light / Dark, per device)
    theme-init.js  classic script: applies the saved theme before first paint
    views/         one module per screen (plus shared pieces like avatar.js)
  i18n/
    en.json
    hu.json
  icons/           UI icons (SVG, used as CSS masks) + generated app icons (PNG)
design/            not served: app icon sources (see "App icons" below)
Dockerfile
compose.yaml
.env.example       placeholder values only
```

## Backend conventions

- **SQL lives inline** in the Rust functions that use it, as plain string literals. Use `?` parameters every time. Never build SQL with `format!`.
- **Every query that touches user data must filter by `user_id`.** User IDs come from the authenticated session, never from the request body or URL. This is the single most important rule in the codebase.
- **Migrations:** numbered `.sql` files in `server/migrations/`, embedded with `include_str!`, applied in order on startup and tracked with `PRAGMA user_version`. Never edit a migration that has been committed. Add a new one. Migrations can use `sha256(text)`, which `db.rs` registers (SQLite has no hash function). At every start (after migrations) the WAL is checkpointed and truncated (`db::checkpoint`), so no old pages linger in it.
- **SQLite settings on every connection:** `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY` (the `scratch` image has no writable `/tmp` for SQLite temp files), `secure_delete=ON` (deleted data is overwritten in the file, not left in free pages).
- **Data types:**
  - Weight is stored as `INTEGER` grams (`weight_g`). The UI shows kg with one decimal place.
  - Calendar days (weigh-ins, period days) are `TEXT` in `YYYY-MM-DD` format and represent the user's local date. Do not convert them to UTC. The server can't know the user's local date, so it only rejects days more than one day past its own UTC date (`future_day`; time zones run up to UTC+14). The forms enforce the exact local "today".
  - Timestamps (created/updated, sessions) are `INTEGER` Unix seconds, UTC.
- **API:** JSON over `/api/*`. Use plain REST-ish routes. Errors go through `AppError` and return `{ "error": "<code>" }` with the right status code. Never leak internal error text to the client.
- **Async + rusqlite:** run DB work inside `tokio::task::spawn_blocking`. Keep it simple: one shared connection behind a `Mutex` is fine at this scale.
- **Lints:** code must pass `cargo fmt` and `cargo clippy -- -D warnings`. Avoid `unwrap()` outside of startup and tests.

## Auth

All of this lives in `server/src/auth.rs`.

- Google OIDC **authorization code flow**, done server-side, with `state` + PKCE. Routes: `GET /auth/google` → Google → `GET /auth/google/callback`.
- `state` and the PKCE verifier live in a short-lived (10 min) HttpOnly cookie scoped to `/auth`, not in the DB. The callback compares `state` before it talks to Google.
- Read the ID token from the token endpoint response (it comes back over TLS directly from Google). Check `iss`, `aud`, and `exp`. Identify users by the **`sub` claim**, never by email, and store it only as its SHA-256 hex (`users.sub_hash`, `auth::sub_hash()`): for personal accounts `sub` is the global Google ID, which public tools can map to a person.
- **No identity in the database.** Email, name and picture are never stored. After sign-in they wait in memory (`PendingProfiles`, by session hash, at most 10 minutes, at most 100 entries with the oldest pushed out first, and one per user: signing in again replaces the waiting one) until that session's first `GET /api/me` returns them as `profile`, once. The browser keeps them in its snapshot (see Privacy) and uses them only if the snapshot's `user.id` matches. If the hand-over is missed (a restart), the app shows "Google account" and a "?" monogram until the next sign-in.
- **Profile picture:** at sign-in the server downloads the `picture` claim's image once (`avatar.rs`: https on `*.googleusercontent.com` only, resized to 384px through Google's URL suffix (4x the largest 96px avatar), at most 200 KB, type detected from the bytes as JPEG/PNG/WebP). It goes to the browser with the profile, as a `data:` URL (hence `img-src 'self' data:` in the CSP). The browser never loads anything from Google. A failed download just means no picture, and never fails the sign-in. The shared HTTP client follows no redirects. The frontend shows a monogram (first letter of the name, or the email) when there's no picture or it fails to load.
- A failed or cancelled sign-in redirects to `/?auth_error=failed|cancelled`. The frontend reads the parameter, removes it from the URL, and shows the message on the login screen.
- **Open signup:** any Google account can sign in, and a user row is created on first login.
- **Sessions:** a random 32-byte token sent to the browser as a cookie (`HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when `SOLENNA_BASE_URL` is https). The DB stores only the **SHA-256 hash** of the token. The server-side expiry is 30 days, sliding, and the extension is written at most once a day per session. The cookie's own `Max-Age` is long (400 days), because the DB expiry is what counts.
- **Handlers get the user from the `CurrentUser` extractor.** Adding it as a handler argument makes the route require a session (401 otherwise), and `user.id` is the only source of the user ID.
- **CSRF:** `SameSite=Lax`, and every state-changing request must be `Content-Type: application/json`. A global middleware returns 415 for anything else, `/auth/logout` included. The frontend's `api()` always sends the header for non-GET requests.
- `POST /auth/logout` deletes the session row and clears the cookie.
- **Rate limit:** one global fixed window (60/min) on the callback's call to Google, checked after the `state` check. That's the only auth step that does real work. `/auth/google` and logout are deliberately not limited: a shared counter on them would let anyone lock everyone out of signing in or out. It's not per-IP either, because that would mean trusting `X-Forwarded-For`. The price of a shared limit: anyone can use it up with their own `state` cookie and made-up codes, which blocks new sign-ins (not existing sessions) while they keep it up. That's accepted; without the limit they could hammer Google through us.
- **Signing in again replaces this browser's previous session.** Sessions on other devices stay.
- **Sign-out only shows the login screen after the server confirms it.** Otherwise a reload would silently sign the user back in.
- **Log only fixed strings from untrusted input:** the callback's `error` parameter is logged only if it's a known OAuth error code.

## Privacy and security

This app stores health data. Treat it accordingly.

- Logs must never contain health values, tokens, cookies, or OAuth codes. Logging user IDs and routes is fine.
- **Data on the device:** `snapshot.js` keeps a copy of the signed-in user's data (`user`, `weights`, `periods`) in localStorage, so the app can show it offline. `user` includes the Google profile, which the server hands over only once. The data is only read when the server can't be reached (the profile on every start), and it's deleted as soon as the state is signed out (logout, any 401, account deletion). Signing out needs the server, so offline the Account screen offers "Remove my data from this device" instead: it clears the snapshot, but the session cookie (HttpOnly) stays, so the app opens the account again once the server is reachable. Its hint says so. Nothing else about the user is stored in the browser.
- Users can **export all their data** (`GET /api/me/export`, JSON) and **delete their account** (`DELETE /api/me`), which hard-deletes the user row and, through `ON DELETE CASCADE`, all their other rows. The server's export has no identity; the browser adds its copy of the profile (name, email, picture) before saving the file. Every new per-user table needs `ON DELETE CASCADE` on its `user_id` and a place in the export.
- Set security headers on every response: a strict CSP (`default-src 'self'`, plus `img-src data:` for the profile picture), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. `/api/*` and `/auth/*` responses also get `Cache-Control: no-store`, so health data and session cookies never sit in a cache.
- Deleting an account also checkpoints the WAL (`db::checkpoint`): `secure_delete` zeroes the rows, but in WAL mode the old pages would stay in the files until the next checkpoint. The checkpoint waits for readers up to `busy_timeout`; if a reader (e.g. a long backup) still holds the database, it logs a warning and the WAL is emptied at the next checkpoint, at the latest the next start. A failed checkpoint never fails the deletion.
- HTTPS is terminated by a reverse proxy in front of the container. The app itself speaks plain HTTP and trusts `SOLENNA_BASE_URL` for building redirect URLs.

## Frontend conventions

- **Supported browsers:** current evergreen browsers, minimum Chrome/Edge 123, Firefox 138, Safari/iOS 17.5. That's what JSON module imports, CSS nesting and `light-dark()` need. Older browsers get a blank page. That's a deliberate trade-off for no build step, so don't add polyfills or transpiling.
- **No build step.** Files in `web/` are served exactly as written. Use `<script type="module">` and relative imports between modules. The one classic script is `theme-init.js` in `<head>`: it has to run before first paint, which a module can't. `index.html` references assets with absolute paths (`/css/app.css`), because it is also served for app routes like `/weight`.
- **Routing:** real paths via the History API (`/weight`, `/cycle`, `/account`). `router.js` owns `HOME`, `navigate()`, link interception and back/forward. It imports no views, so views can use it without an import cycle. The path → view map lives in `app.js`. Same-origin `<a href>` clicks are intercepted. The current path lives in the store.
- **One rendering pattern, used everywhere:** state lives in `store.js`. Each view exports `title` (an i18n key) and `render(container, state)`, which rebuilds its subtree from state. User actions call `api.js`, update the store, and the store re-renders. Don't hand-patch individual DOM nodes from event handlers. Every re-render rebuilds the form inputs too, so a form whose typed values must survive unrelated re-renders keeps them as a draft in its UI state with `remember()` on input (the weight form does). `remember()` updates the state without notifying anyone, so use it only for a screen's UI state (the `...Ui` objects), never for data keys: those must go through `setState` so the snapshot and the screen update. A draft never freezes "today": it only keeps a date the user actually picked.
- **Loading data:** a view may export `load()`. The app calls it each time the view becomes active and the user is signed in. Per-user data lives at the top level of the state (e.g. `weights`), and a screen's UI state lives in one object (e.g. `weightUi`).
- **Sign-out clears user data:** `SIGNED_OUT` in `store.js` lists every per-user state key and resets them all, on logout and on any 401. Add each new kind of user data there, so the next person on a shared device never sees the previous user's data.
- **No inline scripts or styles** (the CSP forbids them): no `<script>` bodies, no `style="..."` attributes, no `on*=` attributes. Use classes and `addEventListener` (the `h()` helper's `on*` props). The one exception is computed positions (e.g. chart dots): set them through `element.style.left = ...` (CSSOM), which the CSP allows, never through a `style` attribute.
- **XSS:** never put user-provided or API data into `innerHTML`. Build elements with `document.createElement` / `textContent`, or the small `h()` helper in `js/dom.js`.
- **i18n:** English and Hungarian. Every user-visible string goes through `t('key')`. No hardcoded UI text. The one exception is the bilingual `<noscript>` text in `index.html`, since `t()` can't run there. Dictionaries are flat key → string JSON objects in `web/i18n/en.json` and `hu.json`, imported as JSON modules. Keys are always written out as complete single-quoted literals (`t('nav.weight')`, or `label: 'nav.weight'` passed to `t()` later), never built dynamically (`` t(`nav.${x}`) ``). `cargo test` treats every single-quoted `section.name`-shaped literal in `web/js` as a key. It checks that both files have the same keys and placeholders, that every key used exists, and that every defined key is used. Other string literals must not look like keys (use `solenna-lang`, not `solenna.lang`). The extraction is a simple heuristic: it pairs up `'` characters per line. So an apostrophe earlier on the same line (`"don't"` in a double-quoted string, or a template literal) can make it miss the keys after it. If the test reports a key as unused that clearly is used, look for a stray apostrophe on that line and move the key to its own line. Interpolation uses `{name}` placeholders: `t('key', { name })`. Language comes from the account's setting (`settings.language`; `null`, also chosen as "Same as device", means the browser's language, then English). Before the account loads (the login screen), the language this device last used comes first. Settings saves run one after another (`saveSettings` in `account.js`), each built from the previous result, so quick changes can't overwrite each other. Period changes do the same (`queue()` in `cycle.js`), and a later success doesn't hide an earlier failure in the same burst. The server's `api::me::LANGUAGES` must list every dictionary (a test checks it). Format dates and numbers with `Intl`, using the active locale.
- **CSS:** modern plain CSS (custom properties, nesting, grid, container queries). Design mobile-first. Desktop gets a wider layout through media/container queries, not a separate UI. Theme colors are custom properties on `:root`, each written once as `light-dark(light, dark)`. The theme follows the OS (`color-scheme: light dark`) unless Settings saved a Light or Dark override on this device: `data-theme` on `<html>` switches `color-scheme`. Never add a separate dark-mode block of colors.
- **Accessibility:** semantic HTML, real `<button>`s and `<label>`s, visible focus styles, and touch targets of at least 44px.
- **"Today" is computed at render time** (`todayIso()`). `app.js` re-renders when the date changes (on returning to the app, and once a minute), so a screen left open overnight never uses yesterday's date. Don't cache today's date anywhere else.
- **Plurals:** don't write `{count} days` into translations. Format counts with `Intl` instead: `formatDays()` gives "1 day" / "5 days" / "5 nap", and `formatRelativeDay()` gives "tomorrow" / "in 9 days".

### Cycle tracking
- **Data:** periods (`start_day`, `end_day` or `null` while ongoing) with a flow level (1 spotting … 5 very heavy) per bleeding day. The API saves a period as a whole (`POST` / `PUT` replace its days and flow). Periods never overlap, an ongoing one counts as open-ended (so it is always the latest), a period is at most 15 days, and an ongoing period can't have started more than 15 days before the server's date (`stale_ongoing`; that's 14 days plus a day of time-zone slack). The server enforces all of this.
- **Logging a start in the past** gives the period an assumed end: the average period length, but never into the next logged period. It stays ongoing only if it could plausibly still be running, so backfilling history works in any order.
- **Predictions are computed in the browser** by `cycle-math.js`, using the calendar method:
  - **Cycle day 1** is the first day of real flow. Leading spotting days belong to the previous cycle, although the calendar still shows them. A period that is spotting only (every day so far logged as spotting) starts no cycle and doesn't count toward lengths; the calendar still shows it, and while it's ongoing the screen says "Spotting, day N" (no expected end) instead of a period day. A day without a logged strength counts as real flow.
  - **Lengths:** cycle and period lengths are averages of the last 6 cycles. Gaps outside 15–60 days are ignored as missed logs, and so are gaps over 1.8× the median of the recent gaps (the last 6; the lower middle value for an even count). A missed log roughly doubles a gap, so 28 + 56 drops the 56, while real variation like 21 + 35 stays. The median is over recent gaps only, so a lasting change in cycle length takes over. The averages note says when gaps were left out. Period lengths count from cycle day 1, like the predictions. They fall back to 28 / 5 days.
  - **Ovulation** is 15 days before the next period start (a 14-day luteal phase, so cycle day 14 of 28). The fertile window is the 5 days before ovulation plus ovulation day.
  - **Fertility levels** follow Wilcox et al. (1995) conception probabilities, in **two levels only**: *fertile* 5–3 days before the estimated ovulation, *high* from 2 days before through ovulation day, none otherwise. Don't add a "peak day" or finer per-day levels: the ovulation date is a calendar estimate that is often off by days, so that would claim false precision.
  - **Fertility is independent of the phase.** In short cycles the fertile window can overlap bleeding days, and those days show it too.
- **Settings toggles** (per account, in `users`): `track_cycle` off hides the Cycle tab and route (data is kept). `show_fertility` off hides the fertility layer: the markers, the fertility legend group, fertility text, the fertile-window / ovulation / "no ovulation estimate" cards, and the ovulation day (it reads as follicular, via `withoutFertility()` in `cycle-math.js`). The follicular and luteal phases deliberately stay, so the switch between them still implies the estimated ovulation; the toggle hides fertility information, it doesn't conceal the estimate. Predictions are still computed; only the view filters them.
- **The calendar has two separate layers. Keep them apart:**
  - **Background colour = phase**, one per day: logged bleeding (shaded by flow strength), predicted bleeding (dashed), follicular, ovulation, luteal.
  - **Fertility = a small marker on top:** one sprout (fertile), two sprouts (high), on any background, bleeding days included.
  - The legend has one group per layer. Don't add fertility as a background colour.
- **Never invent an estimate where the method has nothing to say:**
  - **Short cycles:** a cycle under 21 days, or one where ovulation would fall on or before the period's end, gets no ovulation or fertile window. The screen explains why.
  - **Overdue period:** the current cycle's phase, ovulation and fertility become unknown, and nothing further is predicted. The estimate has just been shown wrong; ovulation most likely came later.
  - **"Late":** the period is only called late after max(5 days, the user's observed cycle spread). Before that, it's "expected N days ago" with a note that a few days of variation is normal.
- **Days up to today always belong to the current logged cycle.** A predicted period only starts a new cycle once it is logged.
- **Always present predictions as estimates.** The disclaimer stays on the screen, and nothing may suggest the app works as contraception.

### App icons
Generated from the two sources in `design/`. Never edit the generated files by hand. Regenerate them from the sources with any image tool:

| Source | Generated |
|---|---|
| `icon-transparent.png` (rounded tile, transparent corners) | `web/favicon.ico` (16/32/48), `web/icons/icon-192.png`, `web/icons/icon-512.png` |
| `icon-filled.png` (opaque, full bleed; the platform applies its own mask) | `web/icons/apple-touch-icon.png` (180), `web/icons/icon-maskable-512.png` |

The transparent source has near-invisible stray pixels (alpha < 8) around the tile. Zero them before downscaling, or they turn into a faint dark fringe.

### PWA / offline
- Offline support covers the **app shell only**. The app opens offline and shows the last data it fetched, but saving requires a connection. Show a clear offline state and disable save buttons while offline.
- `sw.js` precaches the static shell on install and serves it cache-first. App routes (navigations) get the cached `index.html`. It never touches `/api/*` or `/auth/*` (always network). Its `SHELL` list must name every file in `web/`; a `cargo test` checks it, so add new files there.
- `sw.js` has a `VERSION` constant: a hash of everything in `web/`. Installed apps only update when `sw.js` changes, so **any change in `web/` needs a new `VERSION`**. `cargo test` enforces it: it fails and prints the value to put in `sw.js`. A new version activates right away (`skipWaiting`) and deletes the old cache. Browsers only look for a new `sw.js` on a page load, so `app.js` also checks (`registration.update()`) whenever the app returns to the foreground, and reloads the page when a new version takes control (`controllerchange`). It never reloads while an input, textarea or select has focus; it waits for the next return instead. The first install doesn't reload.
- **Offline state:** `state.offline` is true while the device is offline or the server can't be reached. `api()` sets it whenever a request can't reach the server (and fills in data not loaded yet from the snapshot, if it's the same user's), and throws an `ApiError` with code `'network'`; failed saves show `app.networkError` for it (other requests, like export or logout, `app.noConnection`), and a `load()` that fails that way keeps the data it has instead of showing a load error. Screen readers hear the offline message through `#announcer` (a live region outside the re-rendered app, updated only when the message changes, with "back online" once when the connection returns); the visible banner has no live role, so re-renders don't re-announce it. When `/api/me` can't be reached, the app shows the snapshot (see Privacy) with an offline banner; without a snapshot it says there's nothing to show yet. Views don't run `load()` while offline. Every control that saves gets `disabled: state.offline`; reading controls (calendar navigation, chart ranges, the theme) stay enabled. Coming back online, returning to the foreground while offline, or the banner's "Try again" button fetches everything again. The browser's `online` event only means the device has a network, not that our server is reachable, so the button is the only way to recover while the app stays open.
- **Dev:** the service worker isn't registered on `localhost` / `127.0.0.1`, so `cargo run` keeps serving fresh files. To test the service worker locally, open `http://127.0.0.2:8080`, then unregister it and clear its cache afterwards.
- `theme-color` follows the page background (including the theme override), so an installed app's status bar matches. The manifest's colours are the light theme's, used only for the splash screen.

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
- **Dockerfile:** multi-stage, using `cargo-chef` for dependency caching. It builds on `rust:<version>-alpine`, which produces a static musl binary natively for the host architecture, and runs it on `scratch` as uid 10001. TLS uses rustls (aws-lc-rs) with the platform certificate verifier. The Dockerfile copies Alpine's `ca-certificates.crt` into the image for it, so CA updates arrive with each rebuild. Keep the builder image version at or above `rust-version` in `server/Cargo.toml`.
- The SQLite file lives on a volume mounted at `SOLENNA_DATA_DIR`. It is the only state.
- **Platform:** images are built for `linux/amd64` only. The server is x86-64 and ARM isn't planned, so don't add other platforms.
- **CI:** `.github/workflows/ci.yml` runs fmt, clippy and `cargo test --locked` (no Docker build) on every push and pull request. The release workflow calls it for its checks, so they are defined once.
- **Releases:** `.github/workflows/release.yml` builds the image and pushes it to `ghcr.io/balazs-kis/solenna` when `version` in `server/Cargo.toml` has no `v<version>` git tag yet. It runs fmt, clippy and `cargo test --locked` first, and tags the commit after a successful push. Only the current head of `main` is released, also for manual runs. Actions are pinned to full commit SHAs (version in a comment); Dependabot proposes updates. Keep new actions pinned the same way. Bump the version (and commit the updated `Cargo.lock`) to release; nothing else triggers one. The server never builds: `compose.yaml` only pulls the image.
- **Hosting:** `compose.yaml` publishes the app on `127.0.0.1:37510` (localhost only) for Caddy running on the host, which terminates HTTPS. `compose.yaml` also hardens the container: `read_only`, `cap_drop: [ALL]`, `no-new-privileges`; the app writes only to `/data`, so keep it that way. The README has the deploy, backup (SQLite `.backup`, encrypted with `age` to a key that isn't on the server; never a plain copy while running), restore and breach-response steps. Dependabot proposes monthly updates for the actions and the crates. Use `solenna.example.com` in docs, never the real domain.

## Testing

- Use `cargo test` for backend logic and API handlers, run against an in-memory SQLite database with migrations applied.
- Every API resource gets at least one test proving **user A cannot read or modify user B's data**.
- Frontend: no test framework. Keep logic out of views where practical so it stays simple to reason about.
