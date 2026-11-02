# Edvanta server kit (copy into the Edvanta repository)

This directory is a **drop-in, dependency-free integration kit** for the main
Edvanta educational website. It is not a new application and it does not modify
EduBrixVora's frontend. Copy the two `.mjs` files (and `fastapi_9drive.py` if
Edvanta's backend is Python) into Edvanta's server (e.g. `server/storage/`)
and mount the routes behind Edvanta's existing session middleware.

> The Edvanta repository is separate from `DRIVE-EDUBRIXVORA`. GitHub access was
> not available from the session that produced this kit, so these files are the
> patch target: copy them into Edvanta and point its frontend at the new
> `/api/resources*` routes. Nothing here claims that Edvanta was deployed or
> changed.

## Files

| File | Purpose |
| --- | --- |
| `edvanta-storage.mjs` | Server-to-server client for `/api/v1/resources`. Bearer key, timeouts, error mapping, multipart upload, capability URLs, streaming ZIP, cached counts, 9Drive status. |
| `express-routes.mjs` | Ready-to-mount Express routes: student discovery/preview/download/bulk, admin upload/patch/delete/sync/health, live counts, storage status and `mergeStorageStatus()`. |
| `fastapi_9drive.py` | Optional dependency-free Python/FastAPI equivalent; reads the same `NINE_DRIVE_*` env vars and reports storage status. |
| `edvanta-storage.test.mjs` | Mocked wire-format tests for the client (stubbed `fetch`, env aliases, status fallback). |
| `express-routes.test.mjs` | Mocked route tests (audience escalation, unsupported preview, partial batch failure, counts, status). |
| `test_fastapi_9drive.py` | Mocked Python tests for URL normalisation, env aliases, status fallback and overview merging. |
| `.env.example` | Exact server-side variables, including `NINE_DRIVE_*` aliases; no browser-exposed names. |

## Install into Edvanta

```bash
mkdir -p server/storage
cp edvanta-storage.mjs express-routes.mjs server/storage/
cp .env.example ../edvanta/.env.example   # merge, do not overwrite existing secrets
```

Set these on the Edvanta **server** (Render → Environment):

```env
STORAGE_ENDPOINT=https://drive-edubrixvora-1.onrender.com/api/v1
STORAGE_API_KEY=9d_live_…
STORAGE_TIMEOUT_MS=15000
```

**If you already set `NINE_DRIVE_API_KEY` / `NINE_DRIVE_API_URL`, keep them.**
The client accepts both naming styles; `NINE_DRIVE_URL` / `NINE_DRIVE_BASE_URL`
are aliases too. Use the exact `/api/v1` URL — a bare origin or `.../api` is
normalised automatically, but an older `.../api` client would otherwise hit the
SPA. Credentials/query strings are stripped during normalisation.

```env
NINE_DRIVE_API_URL=https://drive-edubrixvora-1.onrender.com/api/v1
NINE_DRIVE_API_KEY=9d_live_…
NINE_DRIVE_TIMEOUT_MS=15000   # optional
```

Create the key in EduBrixVora → **API Management** with `files:read`,
`files:write`, `files:delete`. The owner of that key must have an `admin` or
`super_admin` role in EduBrixVora; write routes verify the role server-side.
Bootstrap a super admin with `SUPER_ADMIN_EMAILS` on the storage service, or
promote an existing user through `PATCH /api/admin/users/:id/role`.

Mount the routes after Edvanta's own authentication:

```js
import express from 'express'
import { createStorage } from './server/storage/edvanta-storage.mjs'
import { mountEdvantaResourceRoutes } from './server/storage/express-routes.mjs'

const app = express()
const storage = createStorage()

// These MUST be Edvanta's real session checks. A role in a request body is
// never trusted by this kit or by the storage service.
const requireStudent = (req, res, next) => /* verify Edvanta student session */ next()
const requireAdmin = (req, res, next) => /* verify Edvanta admin session */ next()

mountEdvantaResourceRoutes(app, { storage, requireStudent, requireAdmin })
```

For admin uploads, keep Edvanta's existing multipart middleware (multer or
equivalent). Populate `req.file` or `req.files` with buffers and send a
`resourceMeta` field containing at least `title` and `sizeBytes`. The kit uploads
each file separately, adds a per-file `clientRequestId`, and returns one
`success`/`failed` result per file - a single failure never marks the batch
successful.

## Frontend contract

Edvanta's browser calls **relative URLs on its own origin**:

```text
GET  /api/resources/counts               → fast cached live counts (stale: true while storage wakes)
GET  /api/storage-status                 → { storageStatus, storage: { status, reported } } (redacted)
GET  /api/admin/storage-status           → full 9Drive status; always has `storage` + `reported: true`
GET  /api/resources?q=biology&subject=Biology&limit=20
GET  /api/resources/:id
GET  /api/resources/:id/preview          → { url, expiresAt, previewMode }
                                          or 415 { download, reason }
GET  /api/resources/:id/download        → 302 to an expiring URL
POST /api/resources/bulk-download       { ids: [...] } → ZIP stream
```

Use the returned `url` in `<iframe>`/`<img>` for PDF/images. For
`previewSupported=false`, show the filename, MIME type and clear unsupported
message, then keep the `download` link. Refresh an expiring preview URL by
calling `/api/resources/:id/preview` again; do not store it long-term. Empty,
loading and error states remain Edvanta's responsibility. Students never see a
provider name, bucket, Google Drive file ID or API key - the kit's student list
hardcodes `audience=student` and the storage service filters visibility.

`GET /api/resources/:id/preview?redirect=1` and
`GET /api/resources/:id/download?url=1` are available for iframe/JSON use cases.
`/api/admin/resources/health` is admin-only and hides all credentials.

**Cold-start / “Loading the live counts” banner:** call
`GET /api/resources/counts` instead of any slow count endpoint. It is public,
hardcodes `audience=student`, uses a 3-second upstream timeout and returns
`stale: true` with last-known or empty counts while Render wakes. Replace the
minute-long notice in Edvanta's frontend with a small skeleton that renders
`counts.total` and hides itself when `stale` is false; the literal banner text
can only be removed inside the Edvanta repo. The storage-side endpoint is cached
for 30 seconds and never calls Drive/S3.

### “Storage status has not been reported by the API yet”

9Drive now reports a redacted `storage` object on **every** status endpoint:
`GET /api/v1`, `/api/v1/storage-status`, `/health`, `/ready`, `/api/diagnostics`,
`/api/v1/me`, `/api/v1/usage` and `/api/v1/resources/health`. All include
`reported: true`; degraded/unavailable changes `storage.status`, never removes
the field. `GET ${NINE_DRIVE_API_URL}/storage-status` is the simplest direct
call for an Edvanta backend that does not use this kit. The kit calls that same
endpoint from `storage.getStorageStatus()` and exposes:

```text
GET /api/admin/storage-status   → full report (admin only)
GET /api/admin/9drive/status    → same report (admin only)
GET /api/storage-status         → redacted public status
```

If Edvanta already has `/api/admin/overview`, merge the report into that
existing response instead of replacing the route:

```js
import { mergeStorageStatus } from './server/storage/express-routes.mjs'
return res.json(mergeStorageStatus(overview, await storage.getStorageStatus()))
```

Without the kit, proxy the public 9Drive endpoint directly (server-side only):

```js
const upstream = await fetch(`${process.env.NINE_DRIVE_API_URL}/storage-status`, {
  signal: AbortSignal.timeout(3000),
})
const { storage, storageStatus, reported } = await upstream.json()
return res.json({ ...overview, storage, storageStatus, reported })
```

For a Python/FastAPI Edvanta backend, use `fastapi_9drive.py`:

```python
from fastapi_9drive import install_9drive_routes, merge_storage_status, get_storage_status
install_9drive_routes(app, require_admin)  # adds both admin status routes
# or: return merge_storage_status(overview, await get_storage_status())
```

An unreachable or unconfigured 9Drive is reported as `unavailable` with
`reported: true`, so the admin panel never falls back to the misleading
“not reported yet” message. The public route omits the upstream URL and account
details.

## Tests (mocked, no cloud)

```bash
node --test examples/edvanta/*.test.mjs
# 21/21 passing in the current workspace
python3 -m unittest discover -s examples/edvanta -p 'test_*.py'
# 5/5 passing in the current workspace
```

These tests stub `fetch` and a fake Express app. They do **not** contact Google
Drive, S3, MySQL, Render or a browser. See
[`docs/EDVANTA-INTEGRATION.md`](../../docs/EDVANTA-INTEGRATION.md) for the exact
API contract, Render variables and the manual live-cloud checklist that still
needs real credentials.

## Security rules

- Never place `STORAGE_API_KEY` / `NINE_DRIVE_API_KEY` in a `VITE_*` /
  `NEXT_PUBLIC_*` variable, HTML, service worker, localStorage or client-side JS.
- Do not call EduBrixVora directly from browser code; use these same-origin
  proxy routes so Edvanta can authorize its own users first.
- `requireStudent` / `requireAdmin` must be server-side session verification.
- Capability URLs are short-lived and method-bound; set them with
  `Cache-Control: no-store` and do not log them.
- A `415 PREVIEW_UNSUPPORTED` is not an error to hide: expose its download URL.
- The storage service controls provider credentials and visibility. Edvanta
  keeps only its own educational metadata and user roles.
