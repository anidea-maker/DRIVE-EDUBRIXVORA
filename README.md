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
- A storage API at `/api/v1` so another website can use 9Drive as its file store: upload, list, download, rename, delete, and mint public URLs.
- S3-style objects - `PUT/GET/HEAD/DELETE /api/v1/objects/<any/key.png>`, list by `prefix` + `delimiter`, quoted `ETag`s, and expiring signed URLs for browsers.
- A copy-paste client for the consuming site in [`examples/other-website`](examples/other-website): two environment variables, no SDK. Keys are scoped (`files:read`, `files:write`, `files:delete`), shown once, stored hashed, and revocable.
- Any origin may call it with a key. Full reference in [docs/API.md](docs/API.md), plus copy-paste examples in **API Management**.

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
| `STORAGE_BACKEND` | Optional. Preselects the storage backend below (`b2`, `idrive_e2`, `dbrij`, `custom`) or a comma-separated preference list (`b2,dbrij`). `s3` means "the first complete backend". Defaults to the first complete backend. |
| `B2_KEY_ID` / `B2_APPLICATION_KEY` / `B2_BUCKET` / `B2_REGION` | Optional. Backblaze B2 credentials. The S3 endpoint is derived (`https://s3.<region>.backblazeb2.com`); `B2_ENDPOINT_URL` overrides it, `B2_DISPLAY_NAME` names the account in the app, and `B2_STORAGE_MAX_GB` (or `B2_STORAGE_MAX_MB`) sets the account's total quota. |
| `IDRIVE_E2_KEY_ID` / `IDRIVE_E2_SECRET_KEY` / `IDRIVE_E2_BUCKET` / `IDRIVE_E2_ENDPOINT_URL` | Optional. IDrive E2 credentials. The endpoint is per account, so it is required. IDrive E2 reports **no quota**, so `IDRIVE_E2_STORAGE_MAX_GB` (or `_MB`) must be set or the account reads "Unlimited" - e.g. `IDRIVE_E2_STORAGE_MAX_GB=10`, or name it after the plan: `IDRIVE_E2_DISPLAY_NAME="IDrive E2-10gb"`. |
| `DBRIJ_STORAGE_URL` / `DBRIJ_STORAGE_ACCESS_KEY` / `DBRIJ_STORAGE_SECRET_KEY` | Optional. Dbrij Storage credentials. A panel REST URL (`https://api.dbrij.com/api/storage`) is **ignored** - that host answers JSON, which the S3 client cannot parse - and `https://s3.dbrij.com` is used instead. Endpoint defaults to `https://s3.dbrij.com` and region to `fsn1` with path-style addressing; `DBRIJ_STORAGE_BUCKET` is optional (the only bucket on the account is used when it is blank), `DBRIJ_REGION` and `DBRIJ_STORAGE_MAX_GB` (or `_MB`) override - Dbrij reports no quota either, so without a cap the account reads "Unlimited" (e.g. `DBRIJ_STORAGE_MAX_GB=5`, or `DBRIJ_DISPLAY_NAME=dbrij-5gb`). **The `AWS_*` block the panel publishes for "S3 tools and SDKs" is read as well** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_S3_BUCKET`), so pasting only that one works. |
| `S3_ENDPOINT_URL` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Optional. Any other S3-compatible provider (Storj, Hetzner, Tigris, DigitalOcean Spaces, Linode, Scaleway, MinIO, AWS). Also `S3_FORCE_PATH_STYLE` (defaults to true when an endpoint is set), `S3_LABEL` (name shown in Settings) and `S3_STORAGE_MAX_GB` / `S3_STORAGE_MAX_MB`. **The standard AWS names work unchanged** - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` (or `AWS_ENDPOINT_URL`), `AWS_REGION`, `AWS_S3_BUCKET` - as do provider-prefixed pairs such as `DBRIJ_STORAGE_URL` / `DBRIJ_STORAGE_ACCESS_KEY` / `DBRIJ_STORAGE_SECRET_KEY`. The backend is named from the endpoint host (Hetzner, Storj, Tigris, …) unless `S3_LABEL` overrides it, and a bucket at the end of a storage URL is split off. `S3_BUCKET` may be left blank when the account holds exactly one bucket - the server lists the buckets with those credentials and uses it (several are reported by name, none is reported as none). Hidden from Settings until one of these is set. |

</details>

<details>
<summary><b>Connecting a bucket without typing credentials</b></summary>

Set the variables for one or more backends above, redeploy, then open **Settings → S3 Compatible**. The modal lists every backend the deployment can see:

- **Ready** backends are one click: bucket, region, endpoint, path-style and the quota cap are filled in, and the key/secret are read server-side, so the browser never receives them.
- **Partly configured** backends say exactly which variable is missing (`B2_REGION`, `DBRIJ_STORAGE_SECRET_KEY`, …) instead of failing at connect time.
- **Enter manually** covers everything else, and does not depend on any variable: pick a provider (Amazon S3, Backblaze B2, Wasabi, Cloudflare R2, or other) and the endpoint is derived from the region for the providers that allow it (B2: `https://s3.<region>.backblazeb2.com`, Wasabi: `https://s3.<region>.wasabisys.com`), with path-style addressing set correctly.

A variable that exists on the service but has an **empty value** is reported as `emptyVars`, separately from ones that are not defined (`unsetVars`) - Render saves a key with no value happily, and that looks configured while behaving exactly like an unset variable.

`GET /api/connected-accounts/s3/presets` returns the same list (secrets redacted), and `GET /api/diagnostics` reports `storage.presets` with what is missing. A connection failure is described, not dumped: `S3_AUTH_FAILED`, `S3_BUCKET_NOT_FOUND`, `S3_ACCESS_DENIED`, `S3_WRONG_REGION`, `S3_ENDPOINT_UNREACHABLE`.

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
| "Connection Failed / Close this window and try again" after **Connect Drive** | The popup now names the cause instead of hiding it, and a failed *quota* read no longer counts as a failed connection. `reason=DRIVE_API_DISABLED` is the common one: enable **Google Drive API** in Google Cloud → APIs & Services → Library. Other codes: `PERMISSION_DENIED`, `INVALID_GRANT` (no refresh token — re-approve), `TOKEN_EXCHANGE_FAILED` (redirect URI mismatch), `STATE_EXPIRED` (retry). Check `GET /api/auth/google/status` and the backend log line `[google-callback] …`. |
| Connect Drive leaves a **blank page**, or the callback returns HTTP 500 | Both OAuth callbacks now always end on the SPA with a `reason=`, and a redirect that cannot be built falls back to a readable page instead of a 500. Run **`GET /api/diagnostics`** (build, `FRONTEND_URL` + where it came from, redirect mode, database, Google redirect URI, hints) and **`GET /api/diagnostics/oauth`** (calls both callbacks inside the deployed process and prints their status and `Location`). That pair identifies the cause without the Render log. |
| An S3 endpoint given without `https://` (`s3.ca-east-006.backblazeb2.com`) | Accepted: endpoints from the environment and from the manual form are normalised to an absolute https URL (trailing slashes removed). An unusable value is refused with `S3_ENDPOINT_INVALID` naming an example, instead of failing inside the SDK. `B2_ENDPOINT_URL` is optional - it is derived from `B2_REGION` when absent. |
| Backblaze returns `SignatureDoesNotMatch` although the key is right | `B2_REGION` must match the region inside the endpoint (`s3.<region>.backblazeb2.com`). The preset reports the mismatch in `notes`. Bucket names are lowercase: `B2_BUCKET`/`s3_storage_configs.bucket` are normalized on read, but set the exact lowercase name in Render to avoid `NoSuchBucket` on older connections. |
| A backend was added in Render but Settings still does not list it | The dialog re-reads `GET /connected-accounts/s3/presets` every time it opens (the response is `Cache-Control: no-store`), so close and reopen it - or press **Refresh** in the dialog. It prints the time it was read ("Read from the server at …") and lists what an unready backend is still missing. If it says *the server did not list the backends*, that request failed, and the reason is shown instead of an empty list. Saving env variables also requires the Render service to restart before they exist in the process. |
| **Connect S3** appears to do nothing | The result is shown inside the dialog now. Previously a failure was printed on the page behind the open dialog, so it was invisible. |
| The provider block has no bucket name | Leave the bucket field blank and press **Connect S3**: the server calls `ListBuckets` with those credentials, and if the account holds exactly one bucket it is used. `S3_BUCKET_AMBIGUOUS` lists the buckets to choose from, `S3_NO_BUCKETS` means the account has none yet, and `S3_BUCKET_UNKNOWN` means listing is denied by the key - in that case copy the bucket name from the console. |
| The provider gave me a block of `AWS_*` variables | Paste them as they are: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` (or `AWS_ENDPOINT_URL`), `AWS_REGION` and `AWS_S3_BUCKET` are read for the **S3 compatible** backend, which is then named after the host (`AWS_ENDPOINT_URL_S3=https://fsn1.your-objectstorage.com` + `AWS_REGION=fsn1` becomes **Hetzner Object Storage**). Provider-prefixed blocks (`DBRIJ_STORAGE_URL`, `DBRIJ_STORAGE_ACCESS_KEY`, `DBRIJ_STORAGE_SECRET_KEY`) are read too, and a bucket at the end of the storage URL (`…/my-bucket`) is split off and used. The dialog lists which variables supplied each value. |
| An endpoint such as `https://fsn1.your-objectstorage.com` is ignored | Fixed: the "your-…" placeholder rule applied to credentials was rejecting Hetzner's genuine host. Endpoints are now validated as URLs instead, so a real host that happens to contain `your-` is accepted (`<…>`, `example.com` and filler words are still refused). |
| `Deserialization error` / `char '{' is not expected.:1:1` when connecting | The endpoint answered with **JSON**, not S3 XML: it is the provider's API/dashboard URL rather than its S3 host. Surfaced as `S3_ENDPOINT_NOT_S3`, which names the endpoint and the one to use. For Dbrij, `DBRIJ_STORAGE_URL=https://api.dbrij.com/api/storage` is that trap - the preset now skips it and uses `https://s3.dbrij.com`; for other providers copy the endpoint whose host starts with `s3.`. |
| Dbrij Storage returns `NotFound`, `NoSuchBucket` or `InvalidAccessKeyId` | Dbrij has one endpoint, `https://s3.dbrij.com`, with region `fsn1` and path-style addressing. `DBRIJ_STORAGE_ACCESS_KEY` is the access key, `DBRIJ_STORAGE_SECRET_KEY` the secret. If the panel only gave you the `AWS_*` block, that is read too. `NoSuchBucket` means the bucket name is wrong - leave it blank and the server uses the only bucket on the account, or copy the exact name from the panel. |
| Filebase (`https://s3.filebase.io`) was removed | Its buckets answered `NotFound - UnknownError` on every connect attempt because the key and bucket belonged to the IPFS tier (`https://s3.filebase.com`, `us-east-1`), and the preset could not know which tier a bucket was on. Use **Enter manually → Other** with the endpoint and region of the tier the bucket is actually on, or the `S3_*` variables. |
| A cloud has S3 support but no preset | Use the `S3_*` variables (`S3_ENDPOINT_URL`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `S3_FORCE_PATH_STYLE`, `S3_LABEL`) - the **S3 compatible** chip appears once any of them is set. `S3_LABEL` renames it (e.g. `Storj`). No code change is needed for Storj, Hetzner, Tigris, DigitalOcean Spaces, Linode, Scaleway, MinIO or AWS. |
| `STORAGE_BACKEND=s3` does not select anything | `s3` is a family, not a backend. Accepted values (and aliases) are `b2`/`backblaze`, `idrive_e2`/`idrive`, `dbrij`/`dbrij_storage`, `custom`/`generic`, or a comma-separated preference list such as `b2,idrive_e2`. With no usable value the first complete backend is used. |
| **Connect S3** fails with an endpoint, key or bucket error | The message names the cause: `S3_ENDPOINT_UNREACHABLE` (endpoint URL wrong, or no outbound internet), `S3_AUTH_FAILED` (key ID/secret mismatch), `S3_BUCKET_NOT_FOUND`, `S3_ACCESS_DENIED` (key lacks permission on that bucket), `S3_WRONG_REGION` (copy the region from the console). Endpoints must be the S3 **API** URL with no bucket name in it - Backblaze B2 is `https://s3.<region>.backblazeb2.com`, and path-style addressing is enabled for you. |
| Render build fails with `error TS2339` / `error TS2345` in `backend/src` | The deploy host typechecks against the **real** generated Prisma client, which cannot be generated offline - a local build against a stub can pass while the host fails (this happened with a `connectedAccount.groupBy` call). CI now runs `prisma generate` + `tsc --noEmit` + `build` for backend and frontend on every push (`.github/workflows/typecheck.yml`), so the error shows up on the commit instead of on the deploy. |
| The account cards should show names like `dbrij-5gb` / `IDrive E2-10gb` | Name them from the environment: `DBRIJ_DISPLAY_NAME=dbrij-5gb`, `IDRIVE_E2_DISPLAY_NAME="IDrive E2-10gb"`, `B2_DISPLAY_NAME=…`, `S3_LABEL=…` for the generic backend. **A size inside the name also sets the quota** (`-5gb` -> 5 GB, `-10gb` -> 10 GB, `500MB`, `1.5TB`), so one variable gives both the name and the cap; an explicit `*_STORAGE_MAX_GB`/`_MB` still wins. Existing accounts are renamed on their next quota sync - no need to reconnect. |
| A connected S3 account reads **Unlimited** | The provider reports no total quota (IDrive E2 and Dbrij never do), and no cap was declared when it was connected. State the plan size - `IDRIVE_E2_STORAGE_MAX_GB=10`, `DBRIJ_STORAGE_MAX_GB=5`, `B2_STORAGE_MAX_GB`, `S3_STORAGE_MAX_GB` - and redeploy; the next quota sync adopts the new cap for the existing account without disconnecting it (reconnecting the same bucket also updates it in place). Every `*_STORAGE_MAX_MB` takes a plain number of megabytes instead. |
| `GET /api/diagnostics` shows a storage variable under `emptyVars` | The key exists on the service but its **value** is blank (or still a placeholder such as `<region>`), so it is ignored. In Render → Environment each row has a *Key* and a *Value* column - fill the value, save, redeploy. `unsetVars` means the key is not there at all. Meanwhile **Settings → Connect S3 → Enter manually** works without any environment variable. |
| S3 variables are set on Render but the form is still empty | Only the backends listed by `GET /api/connected-accounts/s3/presets` are read from the environment. A missing variable is reported as `missing` there; placeholders (`<...>`, `your-...`) are ignored, exactly like the Google credentials. Nothing is read until the service is redeployed with those variables. |
| **Connect Drive** does nothing, or Google shows `invalid_client` / `Error 401` | Check `GET /api/auth/google/status` → `configProblem`, or open **Settings → Google OAuth Credentials** (an amber banner appears when the saved client is unusable). The usual cause is a *placeholder* saved as a credential: `GOOGLE_CLIENT_ID=<client id>`, `GOOGLE_CLIENT_SECRET=<client secret>` or `GOOGLE_REDIRECT_URI=https://<new-service>.onrender.com/...`. Placeholders are now ignored everywhere - at boot, on save, and in the redirect - so the client saved through Settings stays in charge. Save the real values (or delete the placeholder env vars) and redeploy. |
| A saved redirect URI like `https://.onrender.com/...` or `https://<new-service>.onrender.com/...` | Those are documentation placeholders, not URLs. The app no longer sends them: every OAuth request derives `redirect_uri` from the host the browser is on and repairs the stored value. Nothing to fix by hand - `GET /api/auth/google/status` shows the URI in use, and the Google Cloud *Authorized redirect URIs* must contain that exact URL. |
| `/health`, `/api/diagnostics` or `/api/diagnostics/oauth` show the app (login page) instead of JSON | An installed service worker was answering navigation requests with the cached app shell. Fixed by adding `/api/*`, `/health`, `/ready` and `/diagnostics` to `navigateFallbackDenylist`. If a browser still does it, close the tab and reload once (the new worker takes over on the next visit). |
| `/api/diagnostics` says `frontend.mode: single-service` but the browser still goes to an old host | It should not: in single-service mode the callbacks redirect with a **relative** path, so `FRONTEND_URL` is not used at all. If you still see another host, the running build is older than this one — check `/health` → `features` contains `oauth-safe-redirect`. |
| Google shows `redirect_uri_mismatch` | The OAuth client's redirect URI must exactly match `GOOGLE_REDIRECT_URI` — for a same-origin deploy that is `https://<your-service>.onrender.com/connected-accounts/google/callback`. Add it in Google Cloud → Credentials → your client → *Authorized redirect URIs*. |
| App loads but every API call fails (or `/api/*` returns `502`) | In the two-service setup `API_UPSTREAM` is missing/wrong. Switch to the single-service image (`./Dockerfile`) and there is nothing to configure. |
| `Cannot GET /ready` (plain text, often with an HTML-ish page) | The backend is answering but on a **build older than the one that added `/ready`**. Check `/health` → `commit`, then redeploy the backend from `main`. Unknown routes now return JSON with the running `commit` instead. |
| `GET /ready` returns `503 {"migrations":"missing"}` | Empty database: run `npm run db:migrate:deploy` (the container also does this on boot). |
| **Failed to fetch** on All Files / Quota Tracker / Connect Drive | The browser never reached the API. GET requests now retry twice (400 ms, 1.2 s) before giving up, so a backend restart, `tsx watch` reload, `vite` restart or a Render free-tier wake-up no longer surfaces as an error. If it still fails: start the backend (`npm run dev` in `backend/`, port 4000) — `/api/*` on the dev server is proxied there; if it runs elsewhere set `API_PROXY_TARGET`. The message now names the URL, the attempt count and the reason, with advice that matches local vs deployed. |
| A panel or menu is **transparent / washed out** in dark mode | The theme is driven by `src/style.css`, which maps a fixed list of Tailwind utilities to CSS variables. Two rules bite: `div.bg-white:not(button)` is forced **transparent**, and `.bg-slate-50/95` is a *different* selector from `.bg-slate-50`, so opacity variants bypass the remap. Use `bg-[var(--card-bg)]` / `bg-[var(--sidebar-bg)]` for surfaces; the common `bg-slate-50/80`, `bg-slate-50/95`, `bg-slate-200/60`, `bg-slate-200/70`, `bg-slate-100/80` and `text-slate-700/800` are now mapped too. |
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

## Storage API

9Drive can be the file store for another website. Create a key under **API Management**, keep it on that site's server, and call the API — any origin may use it, because the key travels in an `Authorization` header, never in a cookie.

```bash
# Upload the request body as one file
curl -X POST "http://localhost:4000/api/v1/files/raw?name=hello.txt" \
  -H "Authorization: Bearer 9d_live_xxx" \
  -H "Content-Type: text/plain" \
  --data-binary @hello.txt

# ...or multipart (filesMeta must come before the files)
curl -X POST "http://localhost:4000/api/v1/files" \
  -H "Authorization: Bearer 9d_live_xxx" \
  -F 'filesMeta=[{"fieldName":"file-0","fileName":"hello.txt","mimeType":"text/plain","sizeBytes":"12"}]' \
  -F "file-0=@hello.txt;type=text/plain"

# Read it back
curl "http://localhost:4000/api/v1/files?limit=20" \
  -H "Authorization: Bearer 9d_live_xxx"

# A URL for <img src>/<video src> that needs no key
curl -X POST "http://localhost:4000/api/v1/files/<id>/share" \
  -H "Authorization: Bearer 9d_live_xxx"
```

Keys are scoped: `files:read`, `files:write`, `files:delete`. Uploads are routed to whichever connected account has room, using the same policy as the dashboard. `GET /api/v1` describes the API, and [docs/API.md](docs/API.md) is the full reference.

## Edvanta resource registry

The same `files` table now also serves the main Edvanta educational site through
`/api/v1/resources`: paginated discovery, retry-safe admin uploads, stable
visibility, provider verification, short-lived preview/download URLs, streaming
ZIPs, reconciliation and health. One stable `id` per resource; a Google Drive
file ID and an S3 object key are kept distinct. No file bytes pass through
Edvanta's database or this app's local disk.

Edvanta's **server** holds the API key and authenticates its own students and
administrators before calling these endpoints. A tested copy-paste kit is in
[`examples/edvanta/`](examples/edvanta/); the exact contract, roles, Render
variables and manual cloud checklist are in
[docs/EDVANTA-INTEGRATION.md](docs/EDVANTA-INTEGRATION.md). The Edvanta
repository itself is a separate project and is not modified here.

```txt
Resources   GET  /api/v1/resources · POST /api/v1/resources (admin, retry-safe)
            GET  /api/v1/resources/:id · PATCH / DELETE (admin)
            GET  /api/v1/resources/:id/access · /preview-url · /preview
                 /download-url · /download · /content (Range)
            POST /api/v1/resources/bulk-download (streaming ZIP)
            POST /api/v1/resources/:id/verify · POST /api/v1/resources/sync (admin)
            GET  /api/v1/resources/health
Admin       GET  /api/admin/users · PATCH /api/admin/users/:id/role (super_admin)
```

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
API keys      GET /api-keys · GET /api-keys/scopes · POST /api-keys · DELETE /api-keys/:id
Activity      GET /audit-logs
Public files  GET /public/files/:token · GET /public/files/:token/download · GET /public/files/:token/preview
Storage API   GET  /api/v1 · GET /api/v1/me · GET /api/v1/usage      (API key, any origin)
              GET  /api/v1/files · POST /api/v1/files · POST /api/v1/files/raw
              GET  /api/v1/files/:id · /content · /download · PATCH / DELETE
              POST /api/v1/files/:id/share · DELETE /api/v1/files/:id/share
              GET  /api/v1/folders · POST /api/v1/folders
              PUT/GET/HEAD/DELETE /api/v1/objects/:key · GET /api/v1/objects?prefix=&delimiter=
              POST /api/v1/objects/sign  (expiring URL for GET/HEAD/PUT)
              GET  /api/public/objects/:key  (signed, no API key)
              POST /api/v1/uploads   (legacy alias for POST /api/v1/files)
              GET/POST/PATCH/DELETE /api/v1/resources  (educational registry)
              /api/v1/resources/:id/preview-url · /download-url · /content · /access
              /api/v1/resources/counts (fast cached live counts) · /api/v1/storage-status · /bulk-download · /sync · /health
Admin roles    GET  /api/admin/users · PATCH /api/admin/users/:id/role
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
- Dashboard/session routes allow only `FRONTEND_URL`. `/api/v1/*` and `/api/public/*` accept any origin because they require a bearer API key or an expiring signed URL; credentials are off.
- Google Drive files are **not** made public: preview/download use authenticated streams or short-lived capability URLs. S3 buckets stay private.
- Protected writes verify the key owner's role in the database; a frontend-supplied role is never trusted. `SUPER_ADMIN_EMAILS` bootstraps role management.
- Never commit `.env` files or share `TOKEN_ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, `OBJECT_URL_SIGNING_SECRET`, OAuth client secrets, or raw share links you want to keep private.

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
