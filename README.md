![9Drive cover](https://i.ibb.co.com/35BySv1C/image.png)

<h1 align="center">9Drive</h1>

<p align="center">
  <b>All your free cloud storage, in one drive.</b><br />
  Connect several Google Drive accounts and S3 buckets, then use them as one self-hosted file manager.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-4f46e5" /></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white" />
  <img alt="MySQL 8+" src="https://img.shields.io/badge/mysql-8%2B-4479A1?logo=mysql&logoColor=white" />
  <img alt="Docker ready" src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" />
  <a href="https://9drive.zenhosta.com"><img alt="Live preview" src="https://img.shields.io/badge/live-preview-6366f1" /></a>
</p>

<p align="center">
  <a href="docs/media/9drive-trailer.mp4">
    <img src="docs/media/9drive-trailer.gif" alt="9Drive trailer: storage meters merge into one 380 GB drive, then the real dashboard connects accounts, routes uploads and shares a file" width="100%" />
  </a>
  <br />
  <sub>▶ 32-second trailer. Click it to open the full-quality MP4 (<code>docs/media/9drive-trailer.mp4</code>).</sub>
</p>

---

## Why 9Drive?

Every Google account comes with 15 GB of free storage. If you have a few accounts, you have plenty of space, but it's split up, and one account always fills up first.

9Drive joins them together. Connect your Google Drive accounts (and any S3-compatible bucket), and you get:

- 📦 **One storage pool.** See the combined quota of every connected account on one dashboard.
- 🧭 **Uploads that pick the right account.** Each file goes to an account that has enough room. You choose the rule: most free space, round-robin, or your own priority order.
- 🗂️ **A normal file manager.** Folders, search, list and grid views, previews, rename, move, and bulk actions.
- 🔗 **Sharing that works.** Public links with a built-in viewer, embeds, and invites for files and folders.
- 🔌 **An upload API.** Send files from scripts or CI with an API key.
- 🏠 **Your own server.** Files stream straight through your backend to your storage. Nothing is written to the server's disk.

Try the live preview at **[9drive.zenhosta.com](https://9drive.zenhosta.com)**.

## Screenshots

> The screenshots and trailer use made-up demo accounts and files.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/all-files.webp" alt="All Files page with folders and a file list" /><br /><sub><b>All Files</b>: folders with custom icons and colours, plus every file across your accounts.</sub></td>
    <td width="50%"><img src="docs/screenshots/quota.webp" alt="Quota Tracker with total storage and upload routing" /><br /><sub><b>Quota Tracker</b>: combined storage and the upload routing order.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/context-menu.webp" alt="Right-click menu on a file" /><br /><sub><b>Right-click menu</b>: preview, download, rename, move, share, invite.</sub></td>
    <td><img src="docs/screenshots/public-file.webp" alt="Public shared file viewer" /><br /><sub><b>Public link</b>: anyone with the link can view or download the file.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/all-files-dark.webp" alt="All Files page in dark mode" /><br /><sub><b>Dark mode</b>, one click from the header.</sub></td>
    <td><img src="docs/screenshots/all-files-grid.webp" alt="All Files page in grid view" /><br /><sub><b>Grid view</b> for browsing visually.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/shared.webp" alt="Shared page with invites" /><br /><sub><b>Shared</b>: what you shared, who accepted, and what was shared with you.</sub></td>
    <td><img src="docs/screenshots/settings.webp" alt="Settings page with connected storage accounts" /><br /><sub><b>Settings</b>: connect Google Drive or S3 and manage the Google OAuth credentials.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/api.webp" alt="API Management page" /><br /><sub><b>API Keys</b>: create keys and copy ready-made upload examples.</sub></td>
    <td><img src="docs/screenshots/activity.webp" alt="Activity Log page" /><br /><sub><b>Activity Log</b>: a trail of uploads, shares, and changes.</sub></td>
  </tr>
</table>

<p align="center"><img src="docs/screenshots/mobile.webp" alt="9Drive on a phone" width="280" /><br /><sub>It works on phones too, and can be installed as a PWA.</sub></p>

## Features

**Storage**
- Google Drive and S3-compatible storage in one dashboard. S3 works with AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2, or any custom endpoint.
- Combined quota summary plus a per-account Quota Tracker.
- Upload routing policies: *most available*, *round-robin*, or *priority order*.
- Google Drive uploads land in a root folder called `9drive`. A manual **Sync Drive** button brings changes you made in Google Drive back into 9Drive.

**Files**
- Upload by streaming, with a progress panel in the bottom-right corner.
- Virtual folders, which you can nest, colour, and give icons.
- Header search with filters for type, account, size, and date.
- Preview images, videos, PDFs, and Office files. Download, rename, move, delete, recycle bin.

**Sharing and teamwork**
- Public share links with a viewer and an embed mode.
- Invite people to a file or folder as a viewer or editor.
- Activity log.

**For developers**
- An external upload API at `POST /api/v1/uploads` with API keys. Keys are shown once, stored hashed, track when they were last used, and can be revoked.
- In-app API docs with cURL and JavaScript examples.

**Accounts and admin**
- Email/password sign-up or **Continue with Google**, which connects your first Drive automatically.
- Google OAuth credentials can be set in **Settings**. No `.env` editing needed.
- Backup/restore and one-click updates from Settings (for PM2 setups).

## Quick start

Pick the option that suits you. Docker is the easiest.

### Option A: Docker (recommended)

You only need Docker. MySQL is included.

```bash
git clone https://github.com/zenhosta/9drive.git
cd 9drive
cp .env.docker.example .env      # Windows PowerShell: Copy-Item .env.docker.example .env
# open .env and set JWT_ACCESS_SECRET and TOKEN_ENCRYPTION_KEY to long random strings
docker compose up -d --build
```

Then open **http://localhost:5173** and create an account. 🎉

What happens behind the scenes:
- The backend runs the database migrations on every start, so updating an existing install keeps your data.
- If `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env` are real values, the Google config is saved automatically. If they are blank, the app still starts and you can add them later in **Settings → Google Credentials**.

| Service  | URL                     |
| -------- | ----------------------- |
| Frontend | http://localhost:5173   |
| Backend  | http://localhost:4000   |
| MySQL    | localhost:3306          |

<details>
<summary><b>Useful Docker commands</b></summary>

```bash
docker compose logs -f backend      # backend logs (also: frontend, mysql)
docker compose exec backend npm run seed:google-config   # re-save Google OAuth config from .env
docker compose down                 # stop
docker compose down -v              # stop and delete the database volume
```

</details>

### Option B: Run locally (for development)

You need **Node.js 20+**, **npm**, and **MySQL 8+** running on your machine.

**1. Run the setup script.** It writes `backend/.env` and `frontend/.env` with secure random keys, installs dependencies, and generates the Prisma client.

```bash
# Linux / macOS
bash ./setup.sh
```

```powershell
# Windows (PowerShell, from the project folder)
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Enter your MySQL URL when asked (default `mysql://root@localhost:3306/9drive`). You can leave the Google credentials empty for now.

**2. Create the tables and start both apps** in two terminals:

```bash
cd backend
npm run prisma:migrate
npm run dev          # http://localhost:4000
```

```bash
cd frontend
npm run dev          # http://localhost:5173
```

<details>
<summary><b>Prefer to set things up by hand?</b></summary>

```bash
cd backend && npm install
cd ../frontend && npm install
mysql -u root -e "CREATE DATABASE IF NOT EXISTS 9drive;"
```

Create `backend/.env` (or run `cd backend && npm run env:setup` to have it written for you, then edit `DATABASE_URL`):

```env
DATABASE_URL="mysql://root@localhost:3306/9drive"
APP_PORT=4000
FRONTEND_URL="http://localhost:5173"
JWT_ACCESS_SECRET="change-this-jwt-secret-at-least-32-chars"
TOKEN_ENCRYPTION_KEY="change-this-encryption-key-32bytes!"
ACCESS_TOKEN_TTL_SECONDS=900
REFRESH_TOKEN_TTL_DAYS=30
MAX_UPLOAD_BYTES=5368709120

# Only read by `npm run seed:google-config`, which stores them encrypted in the database.
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
GOOGLE_REDIRECT_URI="http://localhost:4000/connected-accounts/google/callback"
```

Create `frontend/.env`:

```env
VITE_API_URL=/api
```

Nothing else to configure: the Vite dev server proxies `/api` to `http://localhost:4000`,
so the browser only ever talks to its own origin — the same shape as the Docker
image. If your backend runs somewhere else, point the proxy at it instead of
changing the SPA:

```env
API_PROXY_TARGET=http://localhost:4000
```

If the backend is not running, `/api/*` now answers
`502 {"code":"API_UNREACHABLE","message":"The dev server could not reach the backend at …"}`
instead of a bare `Failed to fetch`.

Note: `VITE_API_URL=http://localhost:4000` from older instructions still works (it is
rewritten to `/api`), but it is no longer the recommended value — it makes the browser
call a different origin, which needs CORS to line up.

Then run `npm run prisma:migrate` in `backend/` and start both dev servers as shown above.

</details>

### Your first five minutes

1. Open http://localhost:5173 and **register**, or use **Continue with Google** (this connects your first Drive automatically).
2. Go to **Settings → Connect Drive** to add more Google accounts, or **Connect S3** to add a bucket.
3. Open **Quota Tracker** to see your combined storage and choose an upload routing mode.
4. Go to **All Files**, create a folder, and upload something. Watch the progress panel in the corner.
5. Right-click the file and choose **Share Link**, then open the link in a private window.

## Connecting Google Drive

Google sign-in and Drive access need a free OAuth client from **Google Cloud Console** (not Google Search Console). It takes about 10 minutes, once.

<details>
<summary><b>Step-by-step Google Cloud setup</b></summary>

1. **Create or pick a project** at https://console.cloud.google.com/. The OAuth client and the Drive API must be in the same project.
2. **Enable the Google Drive API**: *APIs & Services → Library → Google Drive API → Enable*. It can take a few minutes to take effect.
3. **Configure the OAuth consent screen**: *APIs & Services → OAuth consent screen*.
   - User type: **External**. Fill in the app name, support email, and developer contact email.
   - Add these scopes:
     ```txt
     https://www.googleapis.com/auth/drive
     https://www.googleapis.com/auth/userinfo.email
     https://www.googleapis.com/auth/userinfo.profile
     ```
     Full Drive access is needed so that Google sign-in can connect the first Drive and so that files you add to the `9drive` folder by hand can be synced.
   - While the app is in **Testing**, add every Google account you'll use under **Test users**.
4. **Create the OAuth client**: *APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application*.
   - Authorized JavaScript origin: `http://localhost:5173`
   - Authorized redirect URI: `http://localhost:4000/connected-accounts/google/callback`
   - Copy the **Client ID** and **Client Secret**.
5. **Give the credentials to 9Drive.** Either way works:
   - **In the app (easiest):** log in, open **Settings → Google Credentials**, paste the Client ID, Client Secret, and Redirect URI, then click **Save Configuration**.
   - **From the command line:** put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `backend/.env` and run `cd backend && npm run seed:google-config`. With Docker, use `docker compose exec backend npm run seed:google-config`.

Either way, the credentials are encrypted and stored in MySQL as one global config. Google sign-in uses it too.

</details>

## Configuration

<details>
<summary><b>Backend environment variables</b> (<code>backend/.env</code>)</summary>

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | MySQL connection string. For managed MySQL use `sslaccept` (not `ssl-mode`) as described above. |
| `DATABASE_CA_CERT` | Optional. Provider CA certificate as PEM text, base64, or a file path. Materialized to `prisma/certs/db-ca.pem` and applied as `sslcert` + `sslaccept=strict`. |
| `APP_PORT` | Backend port (default `4000`). |
| `FRONTEND_URL` | The frontend's URL. CORS only allows this origin. |
| `JWT_ACCESS_SECRET` | Secret for signing access tokens. At least 32 characters, random. |
| `TOKEN_ENCRYPTION_KEY` | Key for encrypting Google tokens and S3 credentials. At least 32 characters, random. |
| `ACCESS_TOKEN_TTL_SECONDS` | Access token lifetime (default `900`). |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh token lifetime (default `30`). |
| `MAX_UPLOAD_BYTES` | Largest allowed upload (default 5 GB). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Only read by the seed command. The app reads the encrypted copy from the database. |

</details>

<details>
<summary><b>Frontend environment variables</b> (<code>frontend/.env</code>)</summary>

| Variable | What it does |
| --- | --- |
| `VITE_API_URL` | API base. Defaults to `/api` (same origin: nginx or the Vite proxy forwards it). Only set it to an absolute URL if the API really lives on another origin. Vite bakes it in at build time, so **rebuild after changing it**. |
| `API_PROXY_TARGET` | Dev/preview server only: where `npm run dev` proxies `/api` (default `http://localhost:4000`). |

</details>

<details>
<summary><b>Hosted MySQL (Aiven, PlanetScale, RDS, Azure …)</b></summary>

Point `DATABASE_URL` in `backend/.env` at the service and keep everything else the same:

```env
DATABASE_URL="mysql://avnadmin:PASSWORD@mysql-xxxx.y.aivencloud.com:12299/defaultdb?sslaccept=accept_invalid_certs"
```

Three things trip people up:

1. **TLS.** Prisma's MySQL connector has no `ssl-mode` / `sslmode` parameter, so Aiven's copy-paste string (`?ssl-mode=REQUIRED`) is *ignored* and the connection ends up **unencrypted**. Ask for TLS the Prisma way:
   - `?sslaccept=accept_invalid_certs` — encrypted, certificate not verified. Fine to get started.
   - `?sslcert=certs/aiven-ca.pem&sslaccept=strict` — encrypted **and** verified. Download the CA from the provider (Aiven: *Service page → CA certificate*) to `backend/prisma/certs/aiven-ca.pem`; `sslcert` paths resolve relative to `backend/prisma/`.

   On a platform that only lets you set environment variables (Render, Railway, Fly, PM2, Docker), skip the file entirely and put the certificate in `DATABASE_CA_CERT` — PEM text, base64, or a path:

   ```env
   DATABASE_CA_CERT="-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"
   ```

   The backend writes it to `prisma/certs/db-ca.pem` and upgrades `DATABASE_URL` to `sslcert=certs/db-ca.pem&sslaccept=strict` on boot. `npm run db:check` prints `TLS  encrypted (…)` once the connection really is encrypted.
2. **Migrations.** Managed databases usually cannot create the temporary *shadow database* that `prisma migrate dev` needs, so apply the committed migrations instead:
   ```bash
   cd backend
   npm run db:check           # reachability + credentials + TLS sanity check
   npm run db:migrate:deploy  # applies prisma/migrations (never resets data)
   npm run db:status          # what is applied / pending
   ```
3. **Password quoting.** Keep the URL in double quotes; if the password contains `@`, `:`, `/` or `?`, URL-encode it (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `?` → `%3F`).

With Docker, add the override file instead of editing the bundled MySQL service:

```bash
# .env next to docker-compose.yml
DATABASE_URL="mysql://avnadmin:PASSWORD@mysql-xxxx.y.aivencloud.com:12299/defaultdb?sslaccept=accept_invalid_certs"

docker compose -f docker-compose.yml -f docker-compose.external-db.yml up -d --build
```

The backend runs `prisma migrate deploy` on boot, so the schema is created automatically. Hosted platforms (Render, Railway, Fly, …) only need the `DATABASE_URL` env var — the local `backend/.env` helper steps aside whenever the variable is already set.

</details>

## Deploying to Render (or any container host)

### Recommended: one service (no API URL to configure)

The root `Dockerfile` builds the API and the SPA into a single image. Express serves `/` (SPA), `/api/*` (API), `/health` and `/ready`, so the browser always calls the API on its own origin — no `API_UPSTREAM`, no `VITE_API_URL`, no CORS, nothing to get out of sync.

Render: **New → Web Service → Docker**, *Dockerfile Path* `./Dockerfile`, health check `/health`, then set only:

```env
DATABASE_URL      = mysql://avnadmin:PASSWORD@mysql-<id>.<region>.aivencloud.com:PORT/defaultdb
DATABASE_CA_CERT  = <contents of ca.pem>        # Aiven / any managed MySQL
JWT_ACCESS_SECRET = <32+ random chars>
TOKEN_ENCRYPTION_KEY = <32+ random chars>
```

`FRONTEND_URL` is optional here (it defaults to the service's own origin) and `PORT` is injected by the host. Verify with `/ready` → `{"status":"ok","database":"ok","migrations":"16"}`, then open `/register` on the same URL.

Local equivalent:

```bash
docker build -t 9drive .
docker run --rm -p 4000:4000 --env-file backend/.env 9drive
# → app and API both on http://localhost:4000
```

### Alternative: two services (API + static SPA)

The repo ships two images. They talk to each other through a **runtime** proxy, so nothing has to be rebuilt when a URL changes.

| Service | Root | Port | Health check | Env vars that matter |
| --- | --- | --- | --- | --- |
| `backend` | `./backend` | `$PORT` (fallback `4000`) | `/health` (liveness), `/ready` (database) | `DATABASE_URL`, `DATABASE_CA_CERT`, `JWT_ACCESS_SECRET`, `TOKEN_ENCRYPTION_KEY`, `FRONTEND_URL` |
| `frontend` | `./frontend` | `$PORT` (fallback `80`) | `/healthz` | `API_UPSTREAM` = the backend's public URL |

Notes:

- **`PORT` is respected everywhere.** Render injects `PORT=10000`; the API uses it in preference to `APP_PORT`, and nginx listens on it (the config is rendered from `frontend/nginx.conf.template` at container start).
- **`API_UPSTREAM`** takes a full URL (`https://9drive-backend.onrender.com`) or a bare host (`9drive-backend.onrender.com`); the entrypoint adds `http://` when the scheme is missing. A trailing slash is stripped.
- **No `backend` DNS dependency.** The upstream is resolved per request, so the frontend starts even when the API is down or not deployed yet (that used to fail with `host not found in upstream "backend"`).
- The frontend calls `/api/*` on its own origin and nginx forwards it to `API_UPSTREAM`, stripping the `/api` prefix. If you prefer the browser to call the API directly, build with `--build-arg VITE_API_URL=https://api.example.com` instead and leave `API_UPSTREAM` unset.
- A build-time `VITE_API_URL` that points at the frontend's own origin is ignored on purpose (it would make every request hit the SPA and return HTML); the app logs a warning and uses `/api` instead.
- **`FRONTEND_URL` must match the frontend's public origin exactly** (scheme + host, no trailing slash), because CORS only allows that origin.
- The backend applies pending migrations on boot (`prisma migrate deploy`), so the Aiven database is created/updated automatically on the first deploy.
- `render.yaml` in the repo root declares both services and wires them together (`frontend.API_UPSTREAM <- backend.host`, `backend.FRONTEND_URL <- frontend.host`), so a self-reference is impossible. Only `DATABASE_URL` and `DATABASE_CA_CERT` need typing in.
- **Both services are required.** With only the frontend deployed, the SPA loads but every API call fails — there is nothing to proxy to.

### If registration/login fails after deploying

| Symptom | Cause / fix |
| --- | --- |
| Backend log: `No DATABASE_URL is present in this container's environment`, then the deploy exits | The backend service has no `DATABASE_URL`. Render → backend service → *Environment* → add it (`mysql://avnadmin:PASSWORD@HOST:PORT/defaultdb`) plus `DATABASE_CA_CERT` for Aiven, then redeploy. |
| `GET /ready` returns `503 {"database":"unreachable"}` | Reachable process, broken database: wrong `DATABASE_URL`/`DATABASE_CA_CERT`, or the Aiven service is powered off. `npm run db:check` prints the exact failure. |
| Saving Google OAuth credentials fails in **Settings → Google OAuth Credentials** | The save validates before writing: the Client ID must end in `.apps.googleusercontent.com` (a project number, API key or console URL is rejected by name), http:// redirect URIs are refused unless it is localhost, and the redirect URI must end in `/connected-accounts/google/callback`. The error appears directly under the **Save Credentials** button. The previous config is only retired *after* the new one is stored, so a failed save never breaks working sign-in. |
| Google says `redirect_uri_mismatch`, or sign-in stops working after moving hosts | The redirect URI is stored in the database and sent to Google verbatim. Open Settings → Google OAuth Credentials, clear the Redirect URI field and save again — the server fills in this deployment's own origin. `GET /api/auth/google/status` shows `redirectUri`, `expectedRedirectUri` and `redirectUriMatchesOrigin` so you can see the difference. |
| "Continue with Google" fails with `Unexpected token '<'` or `GOOGLE_NOT_CONFIGURED` | Two separate things: (1) a stale frontend build sends the request to the SPA — deploy the single-service image (or delete `VITE_API_URL`); (2) the database has no Google OAuth client yet — add it in **Settings → Google Credentials**, or set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` and run `npm run seed:google-config`. `GET /auth/google/status` reports which it is. |
| Google shows `redirect_uri_mismatch` | The OAuth client's redirect URI must exactly match `GOOGLE_REDIRECT_URI` — for a same-origin deploy that is `https://<your-service>.onrender.com/connected-accounts/google/callback`. Add it in Google Cloud → Credentials → your client → *Authorized redirect URIs*. |
| App loads but every API call fails (or `/api/*` returns `502`) | In the two-service setup `API_UPSTREAM` is missing/wrong. Switch to the single-service image (`./Dockerfile`) and there is nothing to configure. |
| `Cannot GET /ready` (plain text, often with an HTML-ish page) | The backend is answering but on a **build older than the one that added `/ready`**. Check `/health` → `commit`, then redeploy the backend from `main`. Unknown routes now return JSON with the running `commit` instead. |
| `GET /ready` returns `503 {"migrations":"missing"}` | Empty database: run `npm run db:migrate:deploy` (the container also does this on boot). |
| **Failed to fetch** on All Files / Quota Tracker / Connect Drive | The browser never reached the API. GET requests now retry twice (400 ms, 1.2 s) before giving up, so a backend restart, `tsx watch` reload, `vite` restart or a Render free-tier wake-up no longer surfaces as an error. If it still fails: start the backend (`npm run dev` in `backend/`, port 4000) — `/api/*` on the dev server is proxied there; if it runs elsewhere set `API_PROXY_TARGET`. The message now names the URL, the attempt count and the reason, with advice that matches local vs deployed. |
| Can't find **Log Out** / it is cut off at the bottom of the sidebar | The sidebar now scrolls on its own and the storage block + **Log Out** are pinned to its bottom, so they are reachable at any window height. Three more ways out: the **⋮ menu** next to your name (Settings / Log out), the **log-out icon in the mobile header**, and **Log out** in the Settings page header. Logging out clears the session locally and navigates immediately — it no longer waits for the API, so it works even when the backend is down. |
| Signed in but every action says **Bearer token required.** | That is an ended session, not a permissions problem. A `401` that cannot be refreshed now clears the session and redirects to `/login?reason=session&next=…` with a "Your session ended" notice, and returns you to the page you were on after signing in. Previously the shell kept rendering from the cached user while every request failed. |
| The API dies mid-request / everything 502s after a while | Fixed by the crash guards in `backend/src/server.ts`: an unhandled promise rejection used to terminate Node (>=15) because background quota/Drive work is fired from request handlers. It is now logged as `[fatal-guard] …` and the process keeps serving; `SIGTERM` closes the server and the Prisma pool cleanly. |
| `Blocked request. This host is not allowed` from Vite | The dev server only trusts localhost by default; this config sets `allowedHosts: true` so tunnels, containers and phone-on-LAN work. Restart `npm run dev` after pulling. |
| `Unexpected token '<', "<!doctype "... is not valid JSON` | The API call got `index.html` back, so it never reached the API. Usually `VITE_API_URL` is set to the frontend's own URL. Builds now ignore a same-origin `VITE_API_URL` and fall back to `/api`, but delete the variable anyway (it is baked in at build time) and set `API_UPSTREAM` on the frontend service. The error message now names the URL and the fix. |
| `405 Not Allowed` on `POST /api/auth/register`, and the frontend log shows a request to `POST /auth/register` arriving with a nested `X-Forwarded-For` | `API_UPSTREAM` points at the **frontend** service itself, so nginx proxies `/api/x` back to `/x` on the static site. Set it to the backend URL. The entrypoint now logs `ERROR: API_UPSTREAM=… points at this service itself` and `/api` answers `502` with a readable JSON message instead of a loop. |
| `502` with `{"code":"API_UNREACHABLE", …}` | The backend service is not running, is still booting, or `API_UPSTREAM` is wrong/unset (default `http://backend:4000` only exists in docker-compose). Open `<API_UPSTREAM>/health` — it must return `{"status":"ok"}`. |
| Register returns `500` / the backend log shows Prisma errors | Database not reachable or schema missing: check `DATABASE_URL` + `DATABASE_CA_CERT` on the backend, then read the boot log for `prisma migrate deploy` output. |
| Browser console: `blocked by CORS policy` | `FRONTEND_URL` on the backend must equal the frontend origin. Bare hosts are accepted and upgraded to `https://`, but the host must match exactly. |

## Deploying to a server

<details>
<summary><b>VPS with Docker, step by step</b></summary>

1. **Install Docker** (Ubuntu/Debian):
   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose
   sudo systemctl enable --now docker
   ```
2. **Clone and configure:**
   ```bash
   git clone https://github.com/zenhosta/9drive.git
   cd 9drive
   cp .env.docker.example .env
   nano .env
   ```
   - `FRONTEND_URL`: your public frontend URL, e.g. `https://9drive.yourdomain.com`
   - `VITE_API_URL`: your public backend URL, e.g. `https://api.9drive.yourdomain.com`
   - `GOOGLE_REDIRECT_URI`: e.g. `https://api.9drive.yourdomain.com/connected-accounts/google/callback`
   - Strong random values for `JWT_ACCESS_SECRET` and `TOKEN_ENCRYPTION_KEY`
   - Your `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
3. **Start it:** `docker compose up -d --build`
4. **Update Google Cloud Console:** add your frontend URL under *Authorized JavaScript origins* and your redirect URI under *Authorized redirect URIs*.

Production tips:
- Put the frontend and backend behind an HTTPS reverse proxy.
- Don't expose the MySQL port to the internet.
- Rebuild the frontend whenever `VITE_API_URL` changes (it is baked in at build time).
- Publish the OAuth consent screen when you're ready. Google may ask to verify public apps.

</details>

<details>
<summary><b>Without Docker</b></summary>

```bash
cd backend
npm run build
npm run start:deploy     # = prisma migrate deploy + start the server
```

```bash
cd frontend
npm run build            # serve frontend/dist with any static web server
```

`prisma migrate deploy` never resets data. If Prisma reports migration drift, stop and repair the migration history first. **Never run `prisma migrate reset` in production.**

</details>

<details>
<summary><b>One-click updates (PM2 setups)</b></summary>

On a VPS where the backend runs under PM2, **Settings** has an update button and a live log viewer. When you press it, the backend runs `update.sh` from the project root. If that file doesn't exist, it falls back to `git pull`.

A typical `update.sh` does the same as these manual commands:

```bash
git reset --hard
git pull origin main
cd backend && npm install && npx prisma generate && npm run build && npx prisma migrate deploy
cd ../frontend && npm install && npm run build
pm2 restart 9drive-backend
```

</details>

## Upload API

Create a key under **API Keys** in the app, then send files as `multipart/form-data`. Each upload is routed using the same rules as the dashboard.

```bash
curl -X POST "http://localhost:4000/api/v1/uploads" \
  -H "Authorization: Bearer 9d_live_xxx" \
  -F 'filesMeta=[{"fieldName":"file-0","fileName":"hello.txt","mimeType":"text/plain","sizeBytes":"12"}]' \
  -F "file-0=@hello.txt;type=text/plain"
```

`filesMeta` must come **before** the files. It's a JSON array of `{ fieldName, fileName, mimeType, sizeBytes, folderId? }`, and each `fieldName` matches a file field (`file-0`, `file-1`, …).

<details>
<summary><b>Full REST API overview</b></summary>

Authenticated routes expect `Authorization: Bearer <accessToken>`.

```txt
Health        GET  /health

Auth          POST /auth/register · POST /auth/login · POST /auth/refresh · POST /auth/logout · GET /auth/me
              GET  /auth/google/url · GET /auth/google/callback · POST /auth/google/exchange

Accounts      GET  /connected-accounts · DELETE /connected-accounts/:id · POST /connected-accounts/:id/sync-quota
              GET  /connected-accounts/google/connect-url · GET /connected-accounts/google/callback
              POST /connected-accounts/s3

Storage       GET  /storage/summary · GET /storage/breakdown
              GET  /storage/routing-policy · PATCH /storage/routing-policy

Folders       GET  /folders?parentId=<id> · GET /folders?all=1 · GET /folders/recent?limit=4
              POST /folders · PATCH /folders/:id · DELETE /folders/:id

Files         GET  /files · /files?folderId=<id> · /files?q=<search> · GET /files/:id · GET /files/trash
              PATCH /files/:id · PATCH /files/batch · DELETE /files/:id · DELETE /files/batch
              POST /files/batch/restore · DELETE /files/batch/permanent · POST /files/batch-download
              POST /files/sync-google · GET /files/shared-links
              POST /files/:id/share · DELETE /files/:id/share · POST /files/:id/public-permission
              POST /files/:id/preview-token · GET /files/:id/view-url · GET /files/:id/download
              GET  /files/preview/:token

Uploads       POST /uploads
              POST /uploads/resumable/init · PUT /uploads/resumable/chunk/:id · GET /uploads/resumable/status/:id

Invites       GET /invites · POST /invites · DELETE /invites/:id
API keys      GET /api-keys · POST /api-keys · DELETE /api-keys/:id
Activity      GET /audit-logs
Public files  GET /public/files/:token · GET /public/files/:token/download · GET /public/files/:token/preview
External API  POST /api/v1/uploads   (API key with the files:upload scope)
```

</details>

## Troubleshooting

<details>
<summary><b>"Google Drive API has not been used in project … or it is disabled"</b></summary>

Enable the Google Drive API in the **same** Cloud project as your OAuth client (*APIs & Services → Library*), then wait a few minutes.

</details>

<details>
<summary><b>"Access blocked … Error 403: access_denied"</b></summary>

Your consent screen is in **Testing** mode. Add the Google account under *OAuth consent screen → Test users*.

</details>

<details>
<summary><b>"Error: Prisma schema validation - (get-config wasm)" / "Error code: P1012" / "error: Environment variable not found: DATABASE_URL."</b></summary>

Prisma reads `DATABASE_URL` from `backend/.env`. The error means that file is missing (fresh clone, fresh container, or the working directory has no `.env`), so Prisma refuses to load the schema.

Fix it from the `backend/` folder:

```bash
npm run env:setup     # creates backend/.env from .env.example with random secrets
npm run prisma:migrate
```

If your database is not on `localhost:3306`, edit `DATABASE_URL` in `backend/.env` first, or export it in the shell/Docker/PM2 environment (a value already in the environment always wins).

`npm run dev`, `npm start` and every `prisma:*` / seed script now run that check automatically, so the file is created on first use. Typing `npx prisma ...` by hand skips the check, so run `npm run env:setup` once before that.

The API also validates the same variables at boot and prints the exact ones that are missing instead of an opaque Zod error.

</details>

<details>
<summary><b>Prisma client generation fails on Windows</b></summary>

A running Node process is locking the file. Stop the backend and frontend dev servers, then run `npx prisma generate` in `backend/`.

</details>

<details>
<summary><b>The frontend still calls the old API URL</b></summary>

Vite bakes `VITE_API_URL` into the build. Rebuild the frontend, or with Docker run `docker compose up -d --build`.

</details>

## Security

- Uploads stream through the backend straight to Google Drive or S3. **Nothing is stored on the server's disk.**
- Google tokens and S3 credentials are encrypted in MySQL. App refresh tokens, API keys, preview tokens, and auth-handoff tokens are stored only as hashes.
- CORS only allows `FRONTEND_URL`.
- Never commit `.env` files or share `TOKEN_ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, OAuth client secrets, or raw share links you want to keep private.

## Project structure

```txt
backend/    Express 5 + TypeScript API, Prisma (MySQL), Google Drive and S3 integrations
frontend/   React 19 + Vite + Tailwind CSS 4 app (installable PWA)
docs/       README screenshots and trailer
```

Build checks: `cd backend && npm run build` and `cd frontend && npm run build`.

## Star history

[![Star History Chart](https://star-history.dera.page/svg?repos=zenhosta/9drive&type=Date)](https://star-history.dera.page/#zenhosta/9drive&type=Date)

## License

Copyright 2026 Zenhosta

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
