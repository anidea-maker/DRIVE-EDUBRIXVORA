# Edvanta ↔ EduBrixVora integration

This document is the contract between the two existing applications. It is
written against the code in this repository (`DRIVE-EDUBRIXVORA`, the storage
application) and the drop-in server kit in [`examples/edvanta/`](../examples/edvanta/).

> **Repository boundary.** The Edvanta repository is a separate project. The
> kit in `examples/edvanta/` is real, tested code intended to be copied into
> Edvanta's *server* (not its browser bundle) and mounted behind Edvanta's own
> session middleware. No change to Edvanta's repository is claimed here. The
> student-facing Edvanta UI must call the routes in that kit; it must never
> receive the storage API key.

## 1. Who owns what

| Responsibility | Owner |
| --- | --- |
| Student/admin sign-in, sessions, bookmarks, search UI, category navigation, PDF/image viewer, multi-select UI | Edvanta |
| Verifying that a request really came from a student or administrator before calling storage | **Edvanta server** |
| Unified `files` metadata registry, stable UUIDs, visibility, availability | EduBrixVora |
| Google Drive OAuth tokens, S3 credentials, provider selection/routing, quota, retries | EduBrixVora |
| Actual file bytes | Google Drive / S3-compatible object storage |
| Short-lived preview/download capability URLs, ZIP streaming, health checks | EduBrixVora |
| Database migrations and encrypted secret storage | EduBrixVora |

Intended flow:

```text
Administrator → Edvanta admin UI / EduBrixVora dashboard
             → authenticated storage API (API key or dashboard session)
             → Google Drive or S3 (bytes)
             → files row (id + provider + providerFileId + educational metadata)
             → Edvanta discovery API
             → student preview / single download / ZIP download
```

There is **no circular API call**: EduBrixVora never calls Edvanta. Edvanta calls
EduBrixVora over HTTPS with a server-side API key.

## 2. Authentication and roles

`Authorization: Bearer 9d_live_…` is a server-to-server API key created in
EduBrixVora → **API Management**. It is stored hashed. Scopes:

| Scope | Used for |
| --- | --- |
| `files:read` | discovery, metadata, preview/download URLs, content streaming, ZIP, health |
| `files:write` | uploads, metadata updates, share links, reconciliation (`/sync`, `/verify`) |
| `files:delete` | soft/permanent resource deletion |

Every write route additionally calls `requireRole('manage_resources')`, which
loads the **key owner's** role from MySQL. Roles are `super_admin`, `admin`,
`student`, `visitor`; existing accounts migrate to `admin` so current behaviour
is preserved. A role in a request body/header is never trusted; the Zod schemas
are `.strict()` and reject a `role` field.

Bootstrap a super administrator without editing the database:

```env
SUPER_ADMIN_EMAILS=owner@example.com,second-owner@example.com
```

A super admin can list and change roles through:

```http
GET  /api/admin/users
PATCH /api/admin/users/:id/role    { "role": "admin" | "student" | "visitor" | "super_admin" }
```

Those routes require a dashboard session (`requireAuth`) plus a server-verified
`super_admin` role. Multiple administrators can each have their own account,
connected storage and API key; `uploadedBy` / `lastModifiedBy` and audit logs
record who changed each resource.

Edvanta **must** keep its own student/admin middleware in front of the kit's
routes. `mountEdvantaResourceRoutes(app, { storage, requireStudent, requireAdmin })`:
student routes hardcode `audience=student` and cannot be escalated with
`?audience=admin` from a browser.

## 3. Unified registry

The existing `files` table is the registry; no file contents are stored in MySQL.
Migration `20261102130000_education_resources` is additive and preserves all
existing rows:

| Field | Meaning |
| --- | --- |
| `id` | stable application-level UUID used by Edvanta, independent of provider |
| `name`, `mime_type`, `size_bytes`, `checksum` | file metadata |
| `provider` | `google_drive` or `s3` |
| `provider_file_id` | **Google Drive file ID or S3 object key** - never interchangeable |
| `connected_account_id` | resolves bucket/endpoint/region or Drive OAuth account |
| `object_key` | provider-independent S3-style path (`edvanta/resources/<clientRequestId>/<name>`) |
| `is_resource` | only rows explicitly registered for Edvanta appear in discovery |
| `title`, `description`, `category`, `subject`, `academic_level`, `exam_type` | educational metadata |
| `visibility` | `private`, `students`, `public` (default for new uploads: `students`) |
| `client_request_id` | unique per owner; retry-safe idempotency key |
| `resource_metadata` | optional JSON for future Edvanta fields |
| `uploaded_by`, `last_modified_by` | administrator identity |
| `availability`, `last_verified_at` | `available` / `missing` / `inaccessible` / `unknown` |
| `status`, `deleted_at`, `created_at`, `updated_at` | lifecycle |

Bucket name is returned in API responses by joining `s3_storage_configs`; no
credential is ever serialized. Google Drive IDs and S3 keys are resolved through
`connected_account_id` so a record cannot accidentally point at the wrong cloud
object. Indexes cover owner + resource + status + created-at, plus category,
subject, academic level, exam type and the unique idempotency key.

A student listing never claims an unavailable file: by default it returns only
`availability = 'available'`, and every serialized row includes `available`.

## 4. API contract (`/api/v1/resources`)

`GET /api/v1` returns a machine-readable index including these endpoints.

### Discovery

```http
GET /api/v1/resources?audience=student&q=biology&subject=Biology&category=Science
    &academicLevel=Class%2012&examType=CBSE&provider=s3&limit=50&cursor=…&order=newest
Authorization: Bearer <key with files:read>
```

Query filters: `q`, `category`, `subject`, `academicLevel`, `examType`,
`provider`, `mimeType`, `visibility`, `status`, `availability`, `audience`,
`includeUnavailable`, `limit` (1–200), `cursor`, `order` (`newest`, `oldest`,
`name`). Student audience defaults to `visibility in (students, public)` and
`availability = available`; `audience=admin` additionally requires an admin role.

Response:

```json
{
  "resources": [{
    "id": "uuid",
    "title": "Cell Structure Notes",
    "originalFilename": "biology-ch3.pdf",
    "displayFilename": "Cell Structure Notes",
    "mimeType": "application/pdf",
    "fileSize": "2048",
    "storageProvider": "s3",
    "providerFileId": "9drive/<user>/<file>/biology-ch3.pdf",
    "bucketName": "edvanta-bucket",
    "objectKey": "edvanta/resources/request-12345678/biology-ch3.pdf",
    "googleDriveFileId": null,
    "previewSupported": true,
    "previewMode": "pdf",
    "previewReason": null,
    "category": "Science",
    "subject": "Biology",
    "academicLevel": "Class 12",
    "examType": "CBSE",
    "description": "Chapter 3",
    "uploadedBy": "admin-uuid",
    "visibility": "students",
    "status": "active",
    "availability": "available",
    "available": true,
    "urls": { "metadata": "…", "preview": "…", "previewUrl": "…", "download": "…", "downloadUrl": "…", "content": "…" }
  }],
  "count": 1,
  "hasMore": false,
  "nextCursor": null,
  "audience": "student"
}
```

`fileSize` is a string (5 GiB uploads exceed `Number.MAX_SAFE_INTEGER`).

```http
GET /api/v1/resources/:id?audience=student
```

### Administrator upload

```http
POST /api/v1/resources
Authorization: Bearer <key with files:write, owner role admin/super_admin>
Content-Type: multipart/form-data

resourceMeta = {
  "title": "Cell Structure Notes",
  "description": "Chapter 3",
  "category": "Science",
  "subject": "Biology",
  "academicLevel": "Class 12",
  "examType": "CBSE",
  "visibility": "students",
  "provider": "s3",                  // or "google_drive"; omit for automatic routing
  "clientRequestId": "request-12345678",
  "fileName": "biology-ch3.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": "2048"
}
file = <binary>
```

`resourceMeta` must precede the file part. The backend:

1. streams the body to the selected provider (no full-file buffering),
2. counts/MD5s bytes and rejects a truncated upload,
3. verifies object existence with a provider HEAD/get,
4. only then writes `status=active`, `availability=available`, `is_resource=true`
   and the educational metadata,
5. returns `201 { resource, objectKey, idempotent: true }`.

Retrying with the same `clientRequestId` PUTs to the same `objectKey` and
replaces the row, so no duplicate resource is created. A concurrent conflict
returns `409 RESOURCE_IDEMPOTENCY_CONFLICT` rather than two active rows. If one
file in an admin batch fails, the kit reports that file as `failed` and leaves
the other successes intact.

Other admin endpoints:

```http
PATCH  /api/v1/resources/:id                 { "title": "…", "category": "…", "visibility": "public" }
DELETE /api/v1/resources/:id?permanent=1     # remove bytes at provider; otherwise soft delete
POST   /api/v1/resources/:id/verify          # one HEAD/get, updates availability
POST   /api/v1/resources/sync                # { "limit": 50, "cursor": null, "order": "newest" }
```

`/sync` is on-demand reconciliation: it verifies registry rows against the
provider, updates only `availability` and `last_verified_at`, and returns a
checkpoint cursor. It never overwrites administrator-owned names/categories with
a partial provider answer. There is no background scheduler on Render; call
`/sync` from an Edvanta cron job or an administrator action. Uploads are
event-driven: they set availability immediately after verification.

### Preview and download

| Endpoint | Behaviour |
| --- | --- |
| `GET /resources/:id/access` | mints both short-lived preview and download URLs in one call |
| `GET /resources/:id/preview-url` | PDF/image/text/Google-native docs: `{ url, expiresAt, mechanism }`; Office/unsupported: `415` with a `download` URL and reason |
| `GET /resources/:id/preview` | `302` to the short-lived inline URL |
| `GET /resources/:id/download-url` | short-lived attachment URL |
| `GET /resources/:id/download` | `302` to the short-lived attachment URL |
| `GET /resources/:id/content` | authenticated byte stream for an Edvanta server proxy; supports `Range`, `Content-Disposition`, `X-Content-Type-Options: nosniff` |
| `POST /resources/bulk-download` | `{ "ids": [...] }` → streaming ZIP |

Capability URLs are HMAC-signed (`GET`, one object key, one user, one expiry;
default 10 minutes, max 1 hour) or short-lived hashed share tokens for legacy
rows. The browser receives **no API key and no cloud credential**. Google Drive
files and S3 buckets are never made public. Large PDFs/media use HTTP `Range`
through both the signed URL route and `/content`.

Preview support is deliberately honest:

| Type | Mode |
| --- | --- |
| PDF | embedded viewer / iframe |
| JPEG, PNG, GIF, WebP, AVIF, BMP | `<img>` |
| plain text, Markdown, CSV | inline text with `nosniff` |
| Google Docs/Sheets/Slides/Drawings | backend export stream |
| Word, Excel, PowerPoint | `415` + download URL (no conversion service is configured) |
| SVG, archives, unknown types | `415` + download URL |

### ZIP limits and errors

`POST /resources/bulk-download` preflights each object with a provider HEAD/get.
Files that are missing, inaccessible or private for the audience are skipped and
listed in `X-Resource-Bulk-Error-Count` / `X-Resource-Bulk-Skipped`, and a
`_download-errors.txt` entry is added to the archive. If every file fails, the
response is `502` JSON instead of an empty ZIP. Names are normalised and
collisions resolved (`notes.pdf`, `notes (2).pdf`). Limits:
`RESOURCE_BULK_MAX_FILES` (25) and `RESOURCE_BULK_MAX_BYTES` (512 MiB). The ZIP is
streamed with `archiver`; no whole archive is held in memory.

### Health

```http
GET /api/v1/resources/health
```

Returns database reachability, per-provider account health (`HeadBucket` or Drive
`about.get`), and counts of available/missing/inaccessible/unknown records. It
returns `503` when degraded and never includes a credential. `/health` is
Render's liveness probe; `/ready` checks MySQL and migrations.

## 5. Storage abstraction

[`backend/src/modules/storage/adapters.ts`](../backend/src/modules/storage/adapters.ts)
defines one interface for both providers:

```text
upload_file · get_file_metadata · list_files · get_preview_url · get_download_url
open_read_stream · delete_file · check_storage_health
```

`googleDriveAdapter` and `s3Adapter` wrap the provider services already in this
repo (`google.service.ts`, `s3.service.ts`, `objects.service.ts`,
`stream-*`, `object-signing.ts`). Provider-specific behaviour that was fixed or
added:

- Google Drive `files.get/create/list/delete` use `supportsAllDrives: true` so
  authorised shared-drive files work; OAuth refresh tokens are still encrypted
  and refreshed centrally.
- Google listing is paginated with `nextPageToken`; S3 listing uses
  `ListObjectsV2` continuation tokens.
- Rate limits / 5xx get two short attempts; 401/403 → `inaccessible`, 404 →
  `missing`; provider errors are mapped to safe messages and status codes.
- S3 uploads use `@aws-sdk/lib-storage` multipart streaming; the object key and
  bucket are resolved from the encrypted `s3_storage_configs` row.
- Uploaded bytes are verified with `HeadObject` / `files.get` before success is
  reported. A failed upload cleans up the new provider object and never leaves
  an `active` registry row.
- The object API now actually pipes the request body into its hashing stream
  (previously the provider received an unconnected Transform).

## 6. Security changes in this repository

- Removed every `drive.permissions.create({ type: 'anyone', role: 'writer' })`
  call. Dashboard "Make Public" now returns a short-lived access-controlled
  preview link; `GET /files/:id/view-url` no longer exposes a Google webViewLink
  or changes permissions.
- All external write/delete routes verify the key owner's role on the server.
  API key creation/revocation is admin-only; role changes are super-admin-only.
- Strict Zod validation for all resource metadata; filename normalization;
  object-key path traversal checks; `X-Content-Type-Options: nosniff`;
  `Cache-Control: private, no-store` on capability responses; rate limiting is
  inherited from `requireApiKey`.
- Signed URLs are bound to method, key, user and expiry with a constant-time
  comparison; rotating `OBJECT_URL_SIGNING_SECRET` / `TOKEN_ENCRYPTION_KEY`
  invalidates outstanding links.
- No secret is committed, logged or returned by any endpoint. `.env` remains
  ignored.

## 7. Render deployment

### EduBrixVora (this repository)

Blueprint: [`render.yaml`](../render.yaml), single Docker service built from the
root `Dockerfile` (`API + SPA on one origin`, `SERVE_FRONTEND` set by the image).

| Setting | Value |
| --- | --- |
| Runtime | Docker |
| Dockerfile | `./Dockerfile` |
| Build | handled by the Dockerfile: `npm ci` in `frontend/` and `backend/`, Vite build, `tsc`, Prisma generate |
| Start | root `Dockerfile` CMD runs `npm run db:migrate:deploy`, an optional Google config seed, then `node dist/server.js` (equivalently `npm run start:deploy`) |
| Port | Render injects `PORT`; the app prefers it over `APP_PORT` |
| Health | `/health`; readiness `/ready`; diagnostics `/api/diagnostics` |
| Database | hosted MySQL 8 via `DATABASE_URL`; apply `20261102130000_education_resources` with `npm run db:migrate:deploy` |

Required / relevant environment variables (set in Render → Environment, never in
the frontend build):

```env
DATABASE_URL=mysql://…                 # required
DATABASE_CA_CERT=…                     # managed MySQL CA, if TLS verified
JWT_ACCESS_SECRET=…                    # generated once, >= 32 chars
TOKEN_ENCRYPTION_KEY=…                 # generated once, KEEP STABLE
FRONTEND_URL=https://drive-edubrixvora-1.onrender.com
PUBLIC_BASE_URL=                       # optional; only when a proxy rewrites Host
MAX_UPLOAD_BYTES=5368709120
API_RATE_LIMIT_PER_MINUTE=600
SUPER_ADMIN_EMAILS=owner@example.com   # optional bootstrap for role management
RESOURCE_URL_TTL_SECONDS=600
RESOURCE_BULK_MAX_FILES=25
RESOURCE_BULK_MAX_BYTES=536870912
OBJECT_URL_SIGNING_SECRET=             # optional; derived from TOKEN_ENCRYPTION_KEY when empty
GOOGLE_CLIENT_ID=…                     # seeded into MySQL via Settings / seed script
GOOGLE_CLIENT_SECRET=…
GOOGLE_REDIRECT_URI=https://drive-edubrixvora-1.onrender.com/connected-accounts/google/callback
STORAGE_BACKEND=…                      # optional S3 preset; see backend/.env.example
S3_ENDPOINT_URL=… S3_REGION=… S3_BUCKET=…
S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
DBRIJ_STORAGE_URL=https://s3.dbrij.com
DBRIJ_STORAGE_ACCESS_KEY=… DBRIJ_STORAGE_SECRET_KEY=…
DBRIJ_STORAGE_BUCKET=… DBRIJ_REGION=fsn1
```

`render.yaml` previously declared `DBBYTE_*` variables that no code reads;
they have been replaced with the `DBRIJ_*` names used by
`backend/src/modules/s3/presets.ts`. Google OAuth credentials must be saved in
the database (Settings → Google OAuth Credentials or `npm run
seed:google-config`) and the exact redirect URI above must be registered in
Google Cloud. Google Drive accounts and S3 buckets are connected through the
dashboard; a repository URL alone grants no storage access.

Render's filesystem is ephemeral: no uploaded file is written to local disk, and
all metadata lives in MySQL. Do not change `TOKEN_ENCRYPTION_KEY` after accounts
are connected - encrypted OAuth/S3 credentials would become unreadable.

### Edvanta (separate repository / Render service)

Copy `examples/edvanta/edvanta-storage.mjs` and `express-routes.mjs` into
Edvanta's server, keep them out of any Vite/browser bundle, and set:

```env
STORAGE_ENDPOINT=https://drive-edubrixvora-1.onrender.com/api/v1
STORAGE_API_KEY=9d_live_…              # EduBrixVora → API Management, server-side only
STORAGE_TIMEOUT_MS=15000               # upstream request timeout
```

Mount the routes behind Edvanta's real auth middleware:

```js
import { createStorage } from './edvanta-storage.mjs'
import { mountEdvantaResourceRoutes } from './express-routes.mjs'

const storage = createStorage()
mountEdvantaResourceRoutes(app, { storage, requireStudent, requireAdmin })
```

Edvanta's frontend calls **relative** `/api/resources*` routes on its own origin.
Do not put the storage service URL or API key in `VITE_*`, `NEXT_PUBLIC_*`, HTML
or client JavaScript. Edvanta's own `DATABASE_URL`, JWT secret and app settings
remain unchanged; the two applications do not share a database.

CORS: `/api/v1/*` and `/api/public/*` accept any origin because they require a
bearer key or a signed URL (credentials are off). Dashboard routes remain
restricted to `FRONTEND_URL`. Both services must use HTTPS. Set reasonable
timeouts on Edvanta's proxy (`STORAGE_TIMEOUT_MS`) for large uploads/ZIPs.

## 8. Verification performed in this change

Mocked/automated (no cloud credentials, no MySQL):

```bash
cd backend && npm test                                 # 13/13 pass
cd frontend && npm run build                            # typecheck + Vite + nginx template pass
node --test examples/edvanta/*.test.mjs                 # 13/13 pass
node --test examples/other-website/drive-storage.test.mjs  # 13/13 pass (existing kit)
```

The backend test also runs `tsc`; `dist/` is generated locally. Prisma client
generation in this sandbox used `--no-engine` because `binaries.prisma.sh` is not
reachable here; on Render `npm ci` / `npm run prisma:generate` have normal
network access and produce the full engine.

### NOT verified here (requires real credentials / Edvanta write access)

- Live Google Drive OAuth, shared-drive access, quota and rate-limit behaviour.
- Live S3-compatible uploads, multipart, presigned/provider URL behaviour.
- A real MySQL migration on the deployed database.
- Edvanta's student UI, its own auth system, bookmarks and browser rendering.
- An end-to-end upload → discovery → preview → single/bulk download on Render.

Manual acceptance checklist after deploying both services:

1. `GET /health` and `GET /ready` on EduBrixVora; `GET /api/v1/resources/health`
   with a read key returns database + provider status.
2. Register/log in as an admin; set `SUPER_ADMIN_EMAILS` or promote via
   `/api/admin/users/:id/role`; create an API key with read/write/delete scopes.
3. Connect at least one Google Drive account and one S3-compatible bucket in
   Settings. Confirm `/api/diagnostics` shows both.
4. Upload a PDF, an image, a text file and a DOCX through
   `POST /api/v1/resources` (or the Edvanta admin UI). Confirm each returns
   `availability: available` and a distinct `storageProvider`.
5. Retry one upload with the same `clientRequestId`; confirm one metadata row.
6. List as `audience=student`; confirm private resources are excluded.
7. Open each preview: PDF/image/text render; DOCX returns `415` plus a working
   download URL. Verify preview URLs expire and cannot be replayed as PUT.
8. Download one file and a ZIP of several; delete one object at the provider,
   call `/sync`, and confirm the row becomes `missing` and is excluded.
9. Confirm an unauthenticated browser and a key without `files:write` cannot
   upload/delete; confirm a `student`-role owner cannot manage resources.
10. Confirm no Drive file has an `anyone` permission and no bucket is public.

## 9. Known limitations

- Office files are download-only: neither project includes a safe document
  conversion service. Adding one requires a separate, authenticated renderer.
- Synchronization is on-demand (event-driven after upload + `POST /sync`), not a
  scheduled worker; Render's free/ephemeral processes are not a cron.
- The API-key rate limiter is per-process and in memory; use an external limiter
  for multi-instance deployments.
- A ZIP that fails mid-stream destroys the response rather than silently
  truncating it; preflight HEAD/get catches most provider failures first.
- `SUPER_ADMIN_EMAILS` is a bootstrap convenience, not a replacement for a full
  user-management UI.
- Edvanta's repository was not writable from this session; the integration kit
  must be copied into it and its own frontend routes pointed at the new API.
