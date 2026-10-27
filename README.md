# Solenna

A simple, self-hosted weight and menstrual cycle tracker. It installs as a PWA on phones and also works on desktop.

- **Frontend:** plain HTML, CSS, JavaScript
- **Backend:** Rust (axum) + SQLite
- **Login:** Google
- **Languages:** English, Hungarian

Runs as a single Docker container, configured through `compose.yaml` and a `.env` file (see `.env.example`).

## Deploying

The container serves plain HTTP on `127.0.0.1:37510`. A reverse proxy on the same host (Caddy below) terminates HTTPS. HTTPS is required, for sign-in cookies and so the app can be installed as a PWA.

The examples use `solenna.example.com`; replace it with your domain.

### 1. Google sign-in

In Google Cloud Console (APIs & Services > Credentials), open the OAuth client and add this authorized redirect URI:

```
https://solenna.example.com/auth/google/callback
```

### 2. Configuration

The server needs no checkout of the repo, only two files from it, in a directory of their own (e.g. `/srv/solenna`):

```sh
mkdir -p /srv/solenna && cd /srv/solenna
curl -fsSLO https://raw.githubusercontent.com/balazs-kis/solenna/main/compose.yaml
curl -fsSL https://raw.githubusercontent.com/balazs-kis/solenna/main/.env.example -o .env
```

Set `SOLENNA_BASE_URL=https://solenna.example.com` (no trailing slash) and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `SOLENNA_PORT` and `SOLENNA_DATA_DIR` are fixed by `compose.yaml` and can be left as they are. `.env` holds the client secret: keep it readable only by you (`chmod 600 .env`).

The database lives in `./data`. The container runs as uid 10001, so it needs to own that directory:

```sh
mkdir -p data && sudo chown 10001:10001 data
```

### 3. Caddy

Add a site to `/etc/caddy/Caddyfile`:

```
solenna.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:37510
}
```

`encode` compresses responses; the app itself doesn't. It only applies to text-like types (HTML, CSS, JS, JSON, SVG), so images pass through unchanged. Then `sudo systemctl reload caddy`. Caddy gets and renews the certificate automatically. The app sets its own security headers (CSP and others). It ignores `X-Forwarded-*` headers and builds every URL from `SOLENNA_BASE_URL`.

### 4. Start

```sh
docker compose pull
docker compose up -d
docker compose logs -f
```

Open `https://solenna.example.com` and sign in. To install it on a phone, use the browser's "Install app" / "Add to Home Screen".

### Updating

```sh
docker compose pull
docker compose up -d
```

Database migrations run on startup. Installed apps pick up the new version the next time they're opened. To stay on (or roll back to) a specific release, change `:latest` in `compose.yaml` to its version, e.g. `:0.2.0`. A rollback across a database migration doesn't work: an older version refuses a newer database, so restore a backup from before the update.

## Releasing

Images are built by GitHub Actions (`.github/workflows/release.yml`) and published to `ghcr.io/balazs-kis/solenna`. A release happens when the version changes:

1. Bump `version` in `server/Cargo.toml` (e.g. `0.1.0` → `0.2.0`).
2. Run `cargo build`, so `Cargo.lock` picks up the new version.
3. Commit both files and push to `main`.

The workflow runs fmt, clippy and the tests, builds the image, pushes it tagged with the version, `latest` and the commit SHA, and tags the commit `v<version>`. Pushes that don't change the version do nothing. To retry a failed release, use "Run workflow" on the Actions tab.

The first release creates the `solenna` package on GitHub as private. Make it public once (the package's settings → Change visibility), so the server can pull without logging in.

## Backups

`data/solenna.db` is the only state. It holds health data, so keep backups as private as the server itself (and encrypt any copy that leaves it).

Don't copy the file with `cp` while the app is running: SQLite in WAL mode keeps recent writes in `solenna.db-wal`, and a plain copy can be inconsistent. Use SQLite's online backup instead, which is safe while the app is running. It needs the `sqlite3` tool on the host (`sudo apt install sqlite3`):

```sh
sudo sqlite3 data/solenna.db ".backup '/var/backups/solenna/solenna-$(date +%F).db'"
```

For example, nightly with 30 days kept, in `/etc/cron.d/solenna-backup` (adjust the repo path; `%` must be escaped in cron):

```
30 3 * * * root mkdir -p /var/backups/solenna && chmod 700 /var/backups/solenna && sqlite3 /srv/solenna/data/solenna.db ".backup '/var/backups/solenna/solenna-$(date +\%F).db'" && find /var/backups/solenna -name 'solenna-*.db' -mtime +30 -delete
```

### Restoring

```sh
docker compose down
sudo rm -f data/solenna.db-wal data/solenna.db-shm
sudo cp /var/backups/solenna/solenna-YYYY-MM-DD.db data/solenna.db
sudo chown 10001:10001 data/solenna.db
docker compose up -d
```

## Local development

`cargo run` from the repo root reads `./.env` and serves `web/` from disk, so frontend edits only need a browser refresh. For local sign-in, add `http://localhost:8080/auth/google/callback` as a redirect URI too.

To try the production image locally: `docker build -t solenna .`

## License

MIT, see [LICENSE](LICENSE).
