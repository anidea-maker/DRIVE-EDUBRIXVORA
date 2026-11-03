# Edvanta ↔ 9Drive storage API — integration contract

**Audience:** the Edvanta team wiring its server up to this deployment.

**Deployment:** <https://drive-edubrixvora-1.onrender.com>
**Repository:** `anidea-maker/DRIVE-EDUBRIXVORA` (this one — Edvanta's repository is
separate and was not modified).

This document answers six questions: the base URL, the endpoints and their
request/response shapes, the authentication method, the exact environment
variables, how to deploy on Render, and what has actually been tested.

**About the examples.** Every request/response example below is real output from
this build, executed over HTTP by the end-to-end test. That test substitutes two
things: the database (an in-memory stand-in) and the S3 endpoint (a local
S3-compatible server). So the **shapes, field names, status codes and headers are
exact**, but any *value that depends on the data* — account counts, byte totals,
ids, checksums — reflects that test fixture, not the production deployment. In
particular the `accounts` block in §3.1 is fixture output; do not read it as a
statement about how many accounts your deployment has.

The storage API **already existed** in this repository. Nothing was rebuilt, no
endpoint was renamed, and no storage account was touched: the nine Google Drive
connections and the S3-compatible bucket are exactly as they were. What this
change adds is verification (an end-to-end test that exercises the real
application over HTTP), two small correctness fixes, and this document.

> Deep references: [docs/API.md](API.md) is the full storage-API reference,
> [docs/EDVANTA-INTEGRATION.md](EDVANTA-INTEGRATION.md) is the educational
> resource registry contract, and `GET /api/v1` returns this information in
> machine-readable form.

---

## 1. Base URL

```text
https://drive-edubrixvora-1.onrender.com/api/v1
```

`https://drive-edubrixvora-1.onrender.com` is the origin. Every endpoint below is
relative to it. The `/api/v1` prefix is the versioned, stable surface — use it,
not the bare `/api/upload`-style aliases, which exist only for older clients.

Health and readiness are outside the versioned prefix:

```text
GET /health        liveness; never touches the database
GET /ready         liveness + one database query + migration count
GET /api/diagnostics   deployment self-check (no secrets)
```

---

## 2. Authentication

Server-to-server, header-only bearer key.

```http
Authorization: Bearer 9d_live_…
```

Rules enforced by the server (`backend/src/middleware/api-key.middleware.ts`):

- **Header only.** `?api_key=…` is rejected with `401 API_KEY_QUERY_NOT_ALLOWED`.
  Query strings end up in logs, browser history and `Referer` headers.
- Keys are **stored as a SHA-256 hash**. The plaintext is shown once, when the key
  is created in the dashboard under **API Management**. It cannot be shown again.
- Revoked, expired and unknown keys are rejected with `401`
  (`API_KEY_REVOKED`, `API_KEY_EXPIRED`, `API_KEY_INVALID`).
- A missing scope is `403 API_KEY_SCOPE_MISSING`, and the response names the
  scope that is missing and the scopes the key actually has.

| Scope | Allows |
| --- | --- |
| `files:read` | list, metadata, HEAD, download bytes, listings, usage, minting signed **GET**/**HEAD** URLs |
| `files:write` | uploads, overwrite, rename/move, folders, minting signed **PUT** URLs |
| `files:delete` | delete (trash and permanent) |

The legacy scope `files:upload` still authorises writes (and only writes), so
older keys keep working.

**Who may upload.** Write and delete routes additionally check the *key owner's*
role in the database (`requireRole('manage_resources')`): `admin` or
`super_admin`. A role is never read from the request. New accounts default to
`visitor` and must be promoted; existing administrators are unaffected.

**Rotation.** `POST /api/api-keys/:id/regenerate` (dashboard session, admin role)
revokes the old row and returns a new secret once, preserving name, scopes and
expiry. Deleting and recreating a key revokes every signed URL minted with it.

**CORS.** `/api/v1/*` accepts any origin by default, which is safe precisely
because the key is a header the browser never attaches on its own. If Edvanta's
browser JavaScript ever calls this API directly, set `API_CORS_ORIGINS` to the
exact origins — CORS is not authentication.

### The key must never reach a browser

If Edvanta's HTML needs a URL for `<img>`, `<video>` or a direct download, do
**not** embed an authenticated URL or the key. Mint an expiring signed URL
instead (§3, `POST /api/v1/objects/sign`): the signature *is* the credential, it
is bound to one user, one key, one object and one method, and it stops working
when the key is revoked or the expiry passes.

---

## 3. Endpoints

All request/response bodies below are real output from this build. `sizeBytes` is
a **string**: uploads may be up to 5 GiB, which exceeds
`Number.MAX_SAFE_INTEGER`.

### 3.1 Health and discovery — no key required

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/health` | process, commit, uptime, storage report |
| GET | `/ready` | + `database`, `migrations` (503 if either fails) |
| GET | `/api/v1` | machine-readable index: scopes, limits, all 39 endpoints |
| GET | `/api/v1/storage-status` | redacted storage declaration for admin panels |

```jsonc
// GET /api/v1/storage-status  → 200
// Real response shape. Byte totals and account counts below are from the
// test fixture (9 simulated Drive accounts + 1 local S3 stand-in), not from
// the production deployment - your numbers will differ.
{
  "storage": {
    "status": "connected",              // connected | degraded | unavailable
    "provider": "9drive",
    "reported": true,                   // always true, even when degraded
    "capacity": {
      "reported": true,
      "usedBytes": "28991029248",
      "totalBytes": "146028888064",
      "availableBytes": "117037858816",
      "fileCapRemaining": "117037858816"
    },
    "accounts": { "connected": 10, "googleDrive": 9, "s3": 1 },
    "upload": {
      "available": true,
      "endpoint": "/api/v1/resources",
      "alternativeEndpoint": "/api/v1/files",
      "method": "POST",
      "requiredScope": "files:write",
      "maxBytes": "5368709120",
      "reason": null                    // populated with a safe reason when false
    }
  },
  "storageStatus": "connected",
  "reported": true
}
```

No credential, bucket name, endpoint, account email or token appears in any
status response. That is asserted by a test.

### 3.2 Objects — S3-style, keyed by path

The recommended surface for a new integration: `PUT` writes, `GET` reads, the
same key overwrites, `DELETE` is idempotent.

| Method | Path | Scope |
| --- | --- | --- |
| PUT | `/api/v1/objects/:key` | `files:write` |
| GET | `/api/v1/objects/:key` | `files:read` |
| HEAD | `/api/v1/objects/:key` | `files:read` |
| DELETE | `/api/v1/objects/:key` | `files:delete` |
| GET | `/api/v1/objects` | `files:read` |
| POST | `/api/v1/objects/sign` | `files:read` (GET/HEAD) / `files:write` (PUT) |

**Upload**

```http
PUT /api/v1/objects/edvanta/notes/chapter-1.pdf
Authorization: Bearer 9d_live_…
Content-Type: application/pdf
Content-Length: 19

<raw bytes>
```

```json
// 201 Created (200 on overwrite; `created` distinguishes them)
{
  "key": "edvanta/notes/chapter-1.pdf",
  "name": "chapter-1.pdf",
  "sizeBytes": "19",
  "mimeType": "application/pdf",
  "checksum": "709a6f3bb77b8272db7de4e7695902da",
  "metadata": null,
  "etag": "\"709a6f3bb77b8272db7de4e7695902da\"",
  "createdAt": "2026-11-02T23:23:13.809Z",
  "lastModified": "2026-11-02T23:23:13.842Z",
  "created": true
}
```

`Content-Length` is **required** (or `?sizeBytes=`), because the target account
is chosen before the bytes are read. `ETag` and `Location` are returned as
headers as well.

**Read**

```http
GET /api/v1/objects/edvanta/notes/chapter-1.pdf
```

Returns the bytes with `Content-Type`, `ETag`, `Last-Modified`,
`Accept-Ranges: bytes`, and `X-Content-Type-Options: nosniff`. `If-None-Match`
returns `304`; a `Range` header returns `206` with `Content-Range`. Types that a
browser must not render (SVG, HTML, XML, JavaScript, unknown types) are forced to
`Content-Disposition: attachment` with a CSP sandbox header.

`HEAD` returns the same headers with no body, and `404` with no body for a
missing key.

**List**

```http
GET /api/v1/objects?prefix=edvanta/
```

```json
{
  "prefix": "edvanta/",
  "delimiter": null,
  "objects": [{
    "key": "edvanta/notes/chapter-1.pdf",
    "name": "chapter-1.pdf",
    "sizeBytes": "19",
    "mimeType": "application/pdf",
    "checksum": "709a6f3bb77b8272db7de4e7695902da",
    "createdAt": "2026-11-02T23:23:13.809Z",
    "lastModified": "2026-11-02T23:23:13.842Z",
    "etag": "\"709a6f3bb77b8272db7de4e7695902da\"",
    "metadata": null
  }],
  "prefixes": [],
  "isTruncated": false,
  "nextContinuationToken": null
}
```

Query: `prefix`, `delimiter` (common-prefix folding), `q` (name/key/mime/metadata
search), `checksum` (exact MD5 — content-based duplicate detection), `mimeType`,
`max-keys`, `continuation-token`.

**Signed URL — for a browser, without the key**

```http
POST /api/v1/objects/sign
{ "key": "edvanta/notes/chapter-1.pdf", "method": "GET", "expiresInSeconds": 600 }
```

```json
{
  "key": "edvanta/notes/chapter-1.pdf",
  "method": "GET",
  "url": "https://drive-edubrixvora-1.onrender.com/api/public/objects/edvanta/notes/chapter-1.pdf?u=…&k=api-key%3A…&m=GET&exp=1793662393&sig=…",
  "expiresAt": "2026-11-02T23:33:13.000Z"
}
```

The URL needs no `Authorization` header. The signature covers the user, the
signing key, the object key, the method and the expiry, and the server re-checks
the live key row when the link is used — so revoking the key, removing its scope
or letting it expire invalidates outstanding links immediately. A GET link cannot
be replayed as a PUT.

**Delete**

```http
DELETE /api/v1/objects/edvanta/notes/chapter-1.pdf   → 204 No Content
```

Always `204`, whether or not the object existed (S3 semantics). The bytes are
removed at the provider; a provider failure is reported as `502 DELETE_FAILED`
rather than pretending the delete worked.

### 3.3 Files — id-keyed, shares the dashboard's registry

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/api/v1/files` | `files:read` |
| POST | `/api/v1/files` (multipart) | `files:write` |
| POST | `/api/v1/files/raw` (body = the file) | `files:write` |
| GET | `/api/v1/files/:id` | `files:read` |
| GET | `/api/v1/files/:id/content` and `/download` | `files:read` |
| PATCH | `/api/v1/files/:id` | `files:write` |
| DELETE | `/api/v1/files/:id` (`?permanent=1`) | `files:delete` |
| POST / DELETE | `/api/v1/files/:id/share` | `files:write` |
| GET / POST | `/api/v1/folders` | `files:read` / `files:write` |

```http
POST /api/v1/files/raw?name=chapter-2.pdf&type=application/pdf
Authorization: Bearer 9d_live_…
Content-Type: application/pdf
```

```json
// 201 Created
{
  "file": {
    "id": "file-hkhxx5sg",
    "name": "chapter-2.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": "19",
    "provider": "s3",
    "key": null,
    "folderId": null,
    "folder": null,
    "accountId": "acct-s3-1",
    "status": "active",
    "createdAt": "2026-11-02T23:23:13.882Z",
    "updatedAt": "2026-11-02T23:23:13.894Z",
    "deletedAt": null,
    "urls": {
      "content": "https://drive-edubrixvora-1.onrender.com/api/v1/files/file-hkhxx5sg/content",
      "download": "https://drive-edubrixvora-1.onrender.com/api/v1/files/file-hkhxx5sg/download"
    }
  }
}
```

`GET /api/v1/files/:id` returns the same object plus a `share` field (the current
keyless share link, or `null`).

Multipart uploads must send `sizeBytes` (or a `filesMeta` array for a batch)
**before** the file part, because the provider is chosen before the bytes are
read. File parts may be named `file`, `files`, `upload` or `document`.

`DELETE /api/v1/files/:id` moves the file to the trash — the bytes are untouched
and a subsequent download returns `410 FILE_TRASHED`. `?permanent=1` deletes the
bytes at the provider and the row.

### 3.4 Usage and identity

```http
GET /api/v1/usage     → { storage, accounts, usedBytes, totalBytes, availableBytes }
GET /api/v1/me        → { user, key: { id, scopes }, accounts, storage }
```

Both report capacity across **every** connected account (nine Drive accounts and
one bucket today). `totalBytes` is `null` when any connected account does not
report a quota — the API refuses to imply unlimited space.

### 3.5 Educational resource registry (what Edvanta's UI consumes today)

`GET/POST /api/v1/resources`, `GET/PATCH/DELETE /api/v1/resources/:id`,
`/access`, `/preview-url`, `/download-url`, `/content`, `/bulk-download`,
`/sync`, `/health`, `/counts`. These require the same bearer key; writes
additionally require the admin role. The full contract, including retry-safe
`clientRequestId` uploads and the drop-in server kit, is in
[docs/EDVANTA-INTEGRATION.md](EDVANTA-INTEGRATION.md).

### 3.6 Error model

Every error is JSON with a stable `code`, an operator-safe `message` and, where
useful, a `hint`:

```json
{ "code": "API_KEY_SCOPE_MISSING", "message": "…", "requiredScope": "files:write", "keyScopes": ["files:read"] }
```

| Status | Codes |
| --- | --- |
| 400 | `OBJECT_KEY_INVALID`, `OBJECT_TOKEN_INVALID`, `OBJECT_EMPTY` |
| 401 | `API_KEY_REQUIRED`, `API_KEY_INVALID`, `API_KEY_REVOKED`, `API_KEY_EXPIRED`, `API_KEY_QUERY_NOT_ALLOWED` |
| 403 | `API_KEY_SCOPE_MISSING`, `ROLE_FORBIDDEN`, `SIGNED_URL_*` |
| 404 | `NO_SUCH_KEY`, `NOT_FOUND` |
| 409 | `FILE_TRASHED`, `STORAGE_ACCOUNT_UNAVAILABLE`, `OBJECT_PROVIDER_MIGRATION_UNSUPPORTED` |
| 410 | `FILE_TRASHED` (download of a trashed file), `RESOURCE_MISSING` |
| 411 | `OBJECT_SIZE_REQUIRED`, `UPLOAD_SIZE_REQUIRED` |
| 413 | `OBJECT_TOO_LARGE`, `UPLOAD_TOO_LARGE` |
| 429 | `RATE_LIMITED` (with `Retry-After`, `X-RateLimit-*`) |
| 502 | `UPLOAD_FAILED`, `UPLOAD_VERIFICATION_FAILED`, `DELETE_FAILED`, `S3_*`, `GOOGLE_DRIVE_OPERATION_FAILED` |
| 507 | `NO_ACCOUNT_WITH_ENOUGH_SPACE` |

Provider errors are reduced to these codes on purpose: a raw AWS or Google
message can contain bucket names, endpoints, account emails and tokens. A test
asserts that no failure response leaks them.

---

## 4. Reliability: what "success" means

An upload answers `201` only after, in order:

1. the declared `Content-Length` is checked against the deployment limit;
2. a target account is chosen by the existing routing policy and its free space;
3. the bytes are streamed to the provider while being counted and MD5-hashed
   (nothing is buffered — a 5 GB upload does not need 5 GB of RAM);
4. the received byte count is compared with the declared size — a mismatch is
   `UPLOAD_SIZE_MISMATCH`;
5. the provider is asked to confirm the object exists (3 short attempts, to
   absorb eventual consistency on S3-compatible providers; an auth or permission
   failure is reported immediately);
6. only then is the row marked `active` and the response sent.

On any failure: the partially written provider object is deleted, the provisional
row is removed, and the upload session is marked `failed`. A test proves that a
provider failure yields `502`, leaves **no active row**, leaves the key free for
a retry, and leaks no provider detail in the message.

An overwrite writes the new bytes to a **new** provider key before the row is
repointed, so a failed overwrite leaves the previous version readable instead of
losing both.

---

## 5. Provider selection — read this before your first upload

Uploads are routed by the deployment's existing logic
(`selectAccount` in `backend/src/modules/uploads/upload.routes.ts`), which was
left unchanged:

1. Connected accounts that report enough free space are eligible.
2. The owner's routing policy picks one: `most_available` (default),
   `round_robin`, or `priority`.
3. An **overwrite** of an existing key or file is pinned to the account that
   already holds it — there is no silent migration between providers.

**Consequence for this deployment:** with nine Google Drive accounts (each
reporting ~15 GiB free) and one S3 bucket, the default `most_available` policy
selects a **Google Drive** account, not the bucket. That is the pre-existing
behaviour and it is deliberate. To target the bucket instead, use one of:

- set the owner's routing policy to `priority` with the bucket first
  (Settings → upload routing) — this is what the end-to-end test does;
- send `provider: "s3"` in `resourceMeta` (or as a plain field) on
  `POST /api/v1/resources` — `"google_drive"`, `"s3"`, and `"9drive"`/`"auto"`
  ("let 9Drive choose") are all accepted;
- `PUT /api/v1/objects/<key>` uses the policy for a first write and pins
  subsequent overwrites to the account that holds the object.

If no connected account has room, the API answers `507
NO_ACCOUNT_WITH_ENOUGH_SPACE` — never a silent failure.

---

## 6. Environment variables

Set on the Render service (Dashboard → Environment), never in the repository.
The blueprint `render.yaml` declares all of them; `sync: false` means Render
leaves the value for you to fill in, and `generateValue: true` means it creates
one.

### Required

| Variable | Notes |
| --- | --- |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Hosted Turso database and its token. A single `DATABASE_URL=libsql://…?authToken=…` also works; `file:./prisma/dev.db` runs locally. |
| `JWT_ACCESS_SECRET` | ≥ 32 chars. `generateValue: true`. |
| `TOKEN_ENCRYPTION_KEY` | ≥ 32 chars. `generateValue: true`. **Rotating this makes every stored Google refresh token and S3 credential unreadable** — back it up and never change it casually. |

### API behaviour

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Rejects with `413`. |
| `API_RATE_LIMIT_PER_MINUTE` | `600` | Per key. `0` disables. |
| `API_RATE_LIMIT_STORAGE` | `memory` | Use `database` when running more than one instance (needs migration `20261102140000_website_api_hardening`). |
| `API_CORS_ORIGINS` | *(empty = any)* | Comma-separated exact browser origins. Only needed if a browser calls the API directly. |
| `OBJECT_URL_SIGNING_SECRET` | derived from `TOKEN_ENCRYPTION_KEY` | Set it to keep signed URLs valid across a key rotation. |
| `REQUEST_TIMEOUT_MS` | `1800000` | Must accommodate your largest upload. |
| `PUBLIC_BASE_URL` | request origin | Set only behind a proxy that rewrites `Host`. |
| `SUPER_ADMIN_EMAILS` | *(empty)* | Comma-separated emails granted `super_admin` without a database edit. Server-side only. |
| `RESOURCE_URL_TTL_SECONDS` | `600` | Lifetime of preview/download capability URLs. |
| `RESOURCE_BULK_MAX_FILES` | `25` | ZIP download limit. |
| `RESOURCE_BULK_MAX_BYTES` | `536870912` | ZIP download limit. |

### Existing storage configuration — do not change

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, plus the
S3-compatible presets `B2_*`, `IDRIVE_E2_*`, `DBRIJ_*` and the generic
`S3_ENDPOINT_URL` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_BUCKET` /
`S3_REGION`. These only let Settings pre-fill one-click connect; the live
credentials for the nine Drive accounts and the bucket live **encrypted in the
database** and were not touched.

### Platform-provided

`PORT` (Render injects it and the app prefers it over `APP_PORT`), `NODE_ENV`,
`RENDER_EXTERNAL_HOSTNAME` (used to derive `FRONTEND_URL` when it is unset), and
`SERVE_FRONTEND` (set by the Dockerfile in single-service mode).

### What Edvanta sets on **its own** server

```env
STORAGE_ENDPOINT=https://drive-edubrixvora-1.onrender.com/api/v1
STORAGE_API_KEY=9d_live_…
STORAGE_TIMEOUT_MS=15000
```

Server-side only. Never `VITE_`, `NEXT_PUBLIC_` or `REACT_APP_` prefixed —
anything with those prefixes ends up in the browser bundle.

---

## 7. Deploying to Render

The repository ships a blueprint (`render.yaml`) that defines one Docker web
service named `9drive` serving the API and the SPA from the same origin, with
`healthCheckPath: /health`.

1. **Push the branch.** Render builds from the root `Dockerfile`, which runs
   `prisma generate` and `npm run build`, and whose `CMD` runs
   `npm run db:migrate:deploy` before starting the server — migrations are
   applied on every boot, so no manual step is needed.
2. **Fill the four required variables** in the service's Environment tab:
   `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and let Render
   generate `JWT_ACCESS_SECRET` and `TOKEN_ENCRYPTION_KEY` once.
3. **Redeploy** (Manual Deploy → *Clear build cache & deploy* if you changed
   dependencies).
4. **Verify the deployment** before handing it to Edvanta:

   ```bash
   curl -s https://drive-edubrixvora-1.onrender.com/health | jq .status          # "ok"
   curl -s https://drive-edubrixvora-1.onrender.com/ready  | jq '{database,migrations}'
   curl -s https://drive-edubrixvora-1.onrender.com/api/v1/storage-status | jq .storage.accounts
   curl -s https://drive-edubrixvora-1.onrender.com/api/diagnostics | jq .hints
   ```

   The last call is the one that tells you storage is really connected. Compare
   it with what you expect rather than with a number from this document —
   `storage.accounts` should read `{ "connected": 10, "googleDrive": 9, "s3": 1 }`
   **only if** nine Drive accounts and one bucket are in fact connected, and
   `storage.status` should be `"connected"` rather than `"degraded"` (which means
   zero connected accounts) or `"unavailable"` (the registry could not be read).
   `/diagnostics` → `hints` names anything it finds wrong.

   `/ready` returning `503` names the cause directly (unreachable database, or
   `migrations: "missing"`).

5. **Make sure the key owner is an administrator.** Either set
   `SUPER_ADMIN_EMAILS=you@example.com` and redeploy (that email resolves to
   `super_admin` on every request), or promote an existing account with
   `PATCH /api/admin/users/:id/role` using a dashboard session.
6. **Create the API key**: dashboard → **API Management** → create with
   `files:read`, `files:write`, `files:delete`. Copy the secret immediately — it
   is shown once and stored hashed.
7. **Hand Edvanta two values only**: the base URL and the key.
8. **Optional hardening.** Set `API_CORS_ORIGINS` if any browser JS calls the API
   directly; set `API_RATE_LIMIT_STORAGE=database` if you scale past one
   instance; set `OBJECT_URL_SIGNING_SECRET` so signed URLs survive a
   `TOKEN_ENCRYPTION_KEY` rotation.

Nothing in this flow disconnects a storage account, deletes a file, or rewrites
a stored credential.

---

## 8. What was tested

Run from this repository at the commit that adds these changes.

| Suite | Command | Result |
| --- | --- | --- |
| Backend unit/registry | `cd backend && npm test` | **63 passed**, 2 failed¹ |
| **New end-to-end API** | `node --test backend/test/api-e2e.test.mjs` | **34 passed** |
| Edvanta drop-in kit (JS) | `node --test examples/edvanta/*.test.mjs` | **22 passed** |
| Website kit (JS) | `node --test examples/other-website/*.test.mjs` | **15 passed** |
| Edvanta kit (Python) | `python3 -m unittest discover -s examples/edvanta -p 'test_*.py'` | **5 passed** |
| TypeScript build | `cd backend && npm run build` | clean |
| Frontend build | `cd frontend && npm run build` | clean (typecheck, Vite, nginx template) |

¹ The two failures are an artefact of the sandbox, not of the code:
`test/objects.test.mjs` and `test/resources.test.mjs` import `dist/config/prisma.js`,
and constructing a `PrismaClient` there tries to load the native query-engine
binary, which this sandbox cannot download (`binaries.prisma.sh` is unreachable).
Every assertion inside both files passes (29/29 across the suite); the runner
only marks the *file* failed because the engine load rejects asynchronously after
the tests finish. On a machine with normal network access — including Render —
these pass.

### The end-to-end suite

`backend/test/api-e2e.test.mjs` boots the **real Express application** over HTTP
and substitutes exactly two things: the database (an in-memory stand-in) and the
S3 provider (a local HTTP server implementing the part of the S3 protocol the
backend uses). Routing, authentication, scope checks, the server-side role
check, upload, verification, streaming, listing, signed URLs, deletion,
serialisation and error handling are all production code. Real bytes travel over
real HTTP, so a `201` means the object really exists at the provider.

It covers, and all of it passes:

- health, readiness, the API index and the storage declaration;
- authentication: missing, invalid, revoked and query-string keys; read-only
  keys refused on write and delete routes; the scopes header;
- tenant isolation: a second tenant's key lists zero objects belonging to the
  first;
- the full object lifecycle: upload → metadata → GET/HEAD/304/Range → overwrite →
  list → signed URL read without a key → tampered signature refused → delete →
  404;
- validation: empty body (`411`), malformed keys (`400`), oversized upload
  (`413`);
- the file API: raw and multipart upload, metadata, byte-exact download, trash
  (bytes retained, `410` on download) then permanent delete (bytes gone at the
  provider);
- storage usage across all ten accounts;
- failure honesty: with the provider refusing writes, the API returns `502`,
  stores no active row, leaves the key reusable, and leaks no bucket, endpoint
  or access key in the message; a later retry at the same key succeeds.

### NOT verified here

- Live Google Drive OAuth, shared-drive access, quota and rate limits.
- Live calls to the real S3-compatible bucket: the end-to-end test talks to a
  local stand-in. The AWS SDK, request signing, key layout and verification
  logic are the real code paths, but a real bucket handshake was not performed
  from this session.
- A migration against a live Turso database (the SQLite migrations were applied to a local file). `prisma validate`
  plus the additive migration files were reviewed; `npm run db:migrate:deploy`
  runs on Render's boot.
- Anything inside Edvanta's own repository, UI, auth or deployment.
- The live Render deployment was not reachable from this sandbox (only
  `github.com`, `npm`, and `pypi` egress), so the URLs above are the configured
  production addresses, not responses captured from them.

The manual acceptance checklist in
[docs/EDVANTA-INTEGRATION.md §8](EDVANTA-INTEGRATION.md) still applies after
deploying.

---

## 9. Changes made in this commit

1. **End-to-end API test** (`backend/test/api-e2e.test.mjs` plus
   `backend/test/helpers/fake-prisma.mjs` and `fake-s3.mjs`): 34 tests that run
   the real application over HTTP. Test-only files; nothing in `src/` imports
   them.
2. **Fix — failed first upload no longer lingers.** When a brand-new object
   upload failed, the provisional row was marked `deleted`, so it appeared in the
   owner's trash and a later retry at the same key reported `created: false`
   (an "overwrite" of an object that never existed). The row is now removed,
   falling back to the old behaviour if the delete fails
   (`backend/src/modules/public-api/objects.service.ts`).
3. **Fix — accurate metadata-store label.** The public status payload advertised
   `Turso` as the store for accounts and file metadata while the deployment then
   ran MySQL; this deployment now uses Turso (libSQL), so the label is accurate
   again. Updated in `backend/src/modules/storage/storage-status.ts`, with the
   matching test and `docs/API.md` updated.
4. **This document**, plus the updated verification numbers in
   [docs/EDVANTA-INTEGRATION.md §8](EDVANTA-INTEGRATION.md).

No endpoint was added, removed or renamed; no storage account, credential or
file was modified; Edvanta's repository was not touched.
