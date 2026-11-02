# Storage API

9Drive can act as the file store for another website: upload from that site's
server, read files back, and serve them to browsers with public URLs that carry
no credentials.

The API speaks JSON over HTTPS, authenticates with an API key, and stores into
whichever storage account has room (S3-compatible buckets and Google Drive are
both supported). Upload routing, quota checks and provider handling are the same
code the dashboard uses — a file uploaded here appears in the dashboard, and a
file uploaded there is readable here.

## Base URL

```
https://<your-9drive-host>/api/v1
```

`GET /api/v1` returns the same information as this document in machine-readable
form: scopes, limits, and every endpoint. Start there when you are integrating.

## Authentication

Create a key in **API Management** in the dashboard. The secret is shown once and
stored only as a SHA-256 hash.

```http
Authorization: Bearer 9d_live_…
```

The key is **header-only**. `?api_key=…` is rejected with
`API_KEY_QUERY_NOT_ALLOWED`: URLs are logged, shared and leaked through
`Referer`. Use a signed URL (below) for anything a browser loads directly.
Create one key for the website. Rotate it with
`POST /api/api-keys/:id/regenerate` (dashboard session + admin role), which
revokes the old row and returns a new secret once.

Keys carry scopes:

| Scope | Allows |
| --- | --- |
| `files:read` | list, inspect metadata, download bytes |
| `files:write` | upload, create folders, rename/move, mint share links |
| `files:delete` | move to trash, permanent delete |

Keys created before scopes existed hold `files:upload`, which still authorises
writes. They cannot read, so anything that needs to look files up again needs a
new key.

## CORS

By default any origin may call these routes with a key. That is safe for
server-to-server use: the key is a bearer token, so a browser never attaches one
by itself, and `credentials` is off. Set `API_CORS_ORIGINS` to a comma-separated
list of exact origins when browser JavaScript calls this API directly; CORS is
not authentication. Dashboard routes (cookies) remain restricted to
`FRONTEND_URL`.

## Files

### Upload (multipart)

```http
POST /api/v1/files
Content-Type: multipart/form-data
```

`filesMeta` must be sent **before** the file parts, because the account has to be
picked from the declared size before bytes arrive.

| Field | Notes |
| --- | --- |
| `filesMeta` | JSON array of `{ fieldName, fileName, mimeType, sizeBytes }` |
| `<fieldName>` | one file part per entry; up to 25 files |

```bash
curl -X POST "$BASE/files" \
  -H "Authorization: Bearer $DRIVE_API_KEY" \
  -F 'filesMeta=[{"fieldName":"file-0","fileName":"hello.txt","mimeType":"text/plain","sizeBytes":"12"}]' \
  -F 'file-0=@hello.txt;type=text/plain'
```

Single-file uploads answer with `{ "file": … }`; batches with
`{ "files": [...], "failed": [...] }`.

### Upload (raw body)

Streams the request body straight to the provider — no multipart, no buffering.

```bash
curl -X POST "$BASE/files/raw?name=hero.jpg" \
  -H "Authorization: Bearer $DRIVE_API_KEY" \
  -H 'Content-Type: image/jpeg' \
  --data-binary @hero.jpg
```

`Content-Length` is required (or `?sizeBytes=`): the target account is chosen
before the bytes are read. Optional query parameters: `name`, `type`,
`folderId`. A name is generated from the mime type when `name` is absent.

### List

```http
GET /api/v1/files?limit=50&cursor=…&folderId=…&root=1&q=invoice&kind=image&order=newest
```

| Parameter | Meaning |
| --- | --- |
| `limit` | 1–200, default 50 |
| `cursor` | `nextCursor` from the previous page |
| `folderId` | files in one folder |
| `root` | `root=1` for files outside any folder |
| `q` | substring of the name |
| `kind` | `image`, `video`, `audio`, `pdf`, `doc`, `archive` |
| `order` | `newest` (default), `oldest`, `name`, `largest` |
| `status` | `active` (default) or `deleted` |

```json
{
  "files": [
    {
      "id": "0f0a…",
      "name": "hero.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": "482913",
      "provider": "s3",
      "folderId": null,
      "createdAt": "2026-05-01T09:12:00.000Z",
      "urls": {
        "content": "https://host/api/v1/files/0f0a…/content",
        "download": "https://host/api/v1/files/0f0a…/download"
      }
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

`sizeBytes` is a **string**. Sizes can exceed `Number.MAX_SAFE_INTEGER`, and a
number would silently lose precision in the client's own accounting.

### Read one

`GET /api/v1/files/:id` → `{ "file": …, "share": { "url": … } | null }`.

### Download

`GET /api/v1/files/:id/content` (add `?download=1` for an attachment) or
`GET /api/v1/files/:id/download`. Both honour `Range`, so video seeking and
resumable downloads work.

### Rename / move

```http
PATCH /api/v1/files/:id
{ "name": "renamed.jpg", "folderId": "<folder id or null>" }
```

### Delete

```http
DELETE /api/v1/files/:id            # move to the trash
DELETE /api/v1/files/:id?permanent=1  # delete from the provider, no undo
```

### Public URLs

This is what makes the API usable from page HTML, where a key must never appear.

```http
POST /api/v1/files/:id/share
{ "expiresInSeconds": 86400 }     # optional; omit for no expiry
```

```json
{
  "url": "https://host/api/public/files/<token>/preview",
  "downloadUrl": "https://host/api/public/files/<token>/download",
  "pageUrl": "https://host/public/files/<token>",
  "expiresAt": null
}
```

```html
<img src="https://host/api/public/files/<token>/preview" alt="" />
<video src="https://host/api/public/files/<token>/preview" controls></video>
```

`DELETE /api/v1/files/:id/share` disables every public URL for that file.

## Objects (S3-style)

Same storage, addressed by path instead of id. This is the surface to use when
you want S3's habits - write a key, read it back, list by prefix - without an S3
client, SigV4, or XML.

| Verb | Path | Behaviour |
| --- | --- | --- |
| `PUT` | `/api/v1/objects/:key` | Body is the object. `201` created, `200` overwritten |
| `GET` | `/api/v1/objects/:key` | Bytes, `Range`, `If-None-Match` → `304` |
| `HEAD` | `/api/v1/objects/:key` | `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, no body |
| `DELETE` | `/api/v1/objects/:key` | Deletes for good. Always `204` |
| `GET` | `/api/v1/objects` | List/search: `prefix`, `delimiter`, `q`, `checksum`, `mimeType`, `max-keys`, `continuation-token` |
| `POST` | `/api/v1/objects/sign` | Expiring URL for `GET`/`HEAD`/`PUT` |

```bash
curl -X PUT "$BASE/objects/branding/logo.png" \
  -H "Authorization: Bearer $DRIVE_API_KEY" \
  -H "Content-Type: image/png" \
  --upload-file ./logo.png
```

**Keys** are paths: no leading or trailing slash, no empty segment, no `.` or
`..`, at most 700 characters. They are opaque - no case folding, no
normalisation - so two callers that agree on a string land on the same object.

**Unique keys** are app-level paths, not filenames. Use a generated id segment
(`uploads/<uuid>/report.pdf`) so two files with the same display name coexist.
The kit exports `uniqueKey(prefix, fileName)` for this.

**Overwrites** stay on the connected account already recorded for that key.
There is no silent provider migration: a disconnected, full or deleted account
returns `409 STORAGE_ACCOUNT_UNAVAILABLE`, and an explicit request to change
provider returns `409 OBJECT_PROVIDER_MIGRATION_UNSUPPORTED`. `PUT` to an
existing key replaces the bytes/metadata, and there is never a second row. On an
S3-backed account this is a single provider `PutObject`; on Google Drive the new
file is written first and the old one removed after, so a failed overwrite leaves
the previous version readable.

**`checksum` / `ETag`** are the MD5 of the body, computed while streaming. List
with `?checksum=<md5>` for content-based duplicate detection rather than
matching filenames. Every write returns the checksum and a quoted ETag;
revalidation and `If-None-Match` cost nothing extra.

**Preview** is allowlisted. PDF, common images, plain text, CSV and common
audio/video may render inline with `X-Content-Type-Options: nosniff` and a
sandbox CSP. SVG, HTML, JavaScript, Office, archives and unknown types are
forced to `Content-Disposition: attachment`; `?download=1` always does the same.

**`DELETE`** is idempotent, like S3: deleting a key that does not exist answers
`204`. A `GET` or `HEAD` for a missing key answers `404` with `NO_SUCH_KEY`
(`HEAD` has no body, as S3 specifies).

**Listing** mirrors the S3 response shape:

```json
{
  "prefix": "branding/",
  "delimiter": "/",
  "objects": [{
    "key": "branding/logo.png",
    "name": "logo.png",
    "sizeBytes": "4829",
    "mimeType": "image/png",
    "checksum": "9b2c…",
    "createdAt": "…",
    "lastModified": "…",
    "etag": "\"9b2c…\"",
    "metadata": null
  }],
  "prefixes": ["branding/icons/"],
  "isTruncated": false,
  "nextContinuationToken": null
}
```

`delimiter=/` collapses everything below the prefix into `prefixes`, which is how
a console renders folders. Paginate with `max-keys` (default 1000) and
`continuation-token` from the previous page. `q` searches name, key and indexed
metadata; `checksum` is an exact content hash; `mimeType` is an exact filter.

### Signed URLs

A browser cannot hold the API key, but it can hold a link. `POST
/api/v1/objects/sign` mints one that is bound to a single key, a single method
and a short expiry:

```json
POST /api/v1/objects/sign
{ "key": "branding/logo.png", "method": "GET", "expiresInSeconds": 3600 }
```

```json
{
  "key": "branding/logo.png",
  "method": "GET",
  "url": "https://host/api/public/objects/branding/logo.png?u=…&k=api-key%3A…&m=GET&exp=…&sig=…",
  "expiresAt": "2026-05-01T10:12:00.000Z"
}
```

- `GET`/`HEAD` links read; `PUT` links write. A `GET` link cannot be replayed as a `PUT`, and a link for one key cannot be pointed at another.
- The signature covers user, signing identity (`k`), object key, method and expiry, and is verified with a constant-time comparison.
- `k` is checked against the live API-key row on every use. Revoking/expiring the key, removing its scope, or changing the owner invalidates outstanding links; resource capability URLs use a `resource:<id>` identity and are checked against that row instead.
- Signing requires the scope the method needs (`files:read` for `GET`, `files:write` for `PUT`), so it can never widen a key's access.
- Links are signed with `OBJECT_URL_SIGNING_SECRET` when set, otherwise a key derived from `TOKEN_ENCRYPTION_KEY` - no configuration needed, and rotating that secret invalidates every outstanding link.

```html
<img src="https://host/api/public/objects/branding/logo.png?u=…&k=api-key%3A…&m=GET&exp=…&sig=…" />
```

### Errors specific to objects

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `OBJECT_KEY_INVALID` | The key has a leading/trailing slash, `//`, `.`, `..`, control characters, or is over 700 characters |
| 400 | `UPLOAD_SIZE_MISMATCH` | Received bytes did not match the declared `Content-Length` |
| 404 | `NO_SUCH_KEY` | No object at that key |
| 409 | `STORAGE_ACCOUNT_UNAVAILABLE` / `OBJECT_PROVIDER_MIGRATION_UNSUPPORTED` | The recorded account is unavailable/full, or an overwrite tried to move providers |
| 411 | `OBJECT_SIZE_REQUIRED` | `PUT` without `Content-Length` |
| 413 | `OBJECT_TOO_LARGE` | Over `MAX_UPLOAD_BYTES` |
| 401/403 | `SIGNED_URL_REQUIRED` / `SIGNED_URL_IDENTITY_REQUIRED` / `SIGNED_URL_PERMISSION_REVOKED` / `SIGNED_URL_EXPIRED` / `SIGNED_URL_INVALID` | Signed link missing, missing identity, no longer authorized, expired, or tampered with |
| 502 | `UPLOAD_VERIFICATION_FAILED` / `S3_*` / `GOOGLE_DRIVE_OPERATION_FAILED` | Provider refused; safe code and operator guidance, never raw credentials or internal paths |

## Folders

```http
GET  /api/v1/folders?all=1
POST /api/v1/folders      { "name": "invoices", "parentId": null }
```

A folder created here also exists in the dashboard, and is mirrored to Google
Drive when a Drive account is connected.

## Account and usage

```http
GET /api/v1/me       # user, key scopes, per-account storage
GET /api/v1/usage    # { usedBytes, totalBytes, availableBytes }
```

`totalBytes` is `null` when at least one connected account reports no quota —
never invent a number there, and never read `null` as "unlimited".

## Limits

| Limit | Value |
| --- | --- |
| Max upload | `MAX_UPLOAD_BYTES` (5 GiB by default) |
| Request timeout | `REQUEST_TIMEOUT_MS` (30 min by default) |
| Requests | `API_RATE_LIMIT_PER_MINUTE` per key (600 by default) |
| Files per multipart request | 25 |

Rate-limit responses are `429` with `Retry-After`, and every response carries
`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`. The default
`API_RATE_LIMIT_STORAGE=memory` protects one instance; set `database` on
multi-instance deployments so all instances share one counter.

## Errors

Errors are JSON with a stable `code` and a message that names the cause.

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `API_KEY_REQUIRED` | No `Authorization` header |
| 401 | `API_KEY_QUERY_NOT_ALLOWED` | Key was sent in `?api_key=`; use the header and rotate it |
| 401 | `API_KEY_INVALID` | Key does not exist (revoked, or copied incompletely) |
| 401 | `API_KEY_REVOKED` / `API_KEY_EXPIRED` | Key is no longer usable |
| 403 | `API_KEY_SCOPE_MISSING` | Key lacks the scope; `requiredScope` and `keyScopes` are in the body |
| 404 | — | File or folder does not belong to this key's user |
| 410 | `FILE_TRASHED` | File is in the trash |
| 411 | `UPLOAD_SIZE_REQUIRED` | Raw upload without `Content-Length` |
| 413 | `UPLOAD_TOO_LARGE` | Over `MAX_UPLOAD_BYTES` |
| 429 | `RATE_LIMITED` | Slow down; see `Retry-After` |
| 502 | `UPLOAD_FAILED` / `DELETE_FAILED` | The provider refused; the message is the provider's |
| 507 | `NO_ACCOUNT_WITH_ENOUGH_SPACE` | Nothing can hold this file |

## Educational resources (Edvanta)

`/api/v1/resources` is the authenticated contract for the main Edvanta website.
It uses the same `files` registry, the same API key and the same scopes, but adds
educational metadata, stable visibility, availability checks, preview/download
capability URLs, streaming ZIPs and reconciliation. A browser must never hold
the API key: Edvanta's server authenticates its own student/admin session first.

| Method | Path | Scope | Extra requirement | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/resources` | `files:read` | — | Paginated discovery: `q`, `category`, `subject`, `academicLevel`, `examType`, `provider`, `mimeType`, `visibility`, `status`, `availability`, `audience`, `limit`, `cursor`, `order` |
| `POST` | `/resources` | `files:write` | admin/super_admin role | Multipart upload: `resourceMeta`, `metadata`, `meta` or plain fields (title, category, subject, `sizeBytes`/`size`, optional `provider`, `clientRequestId`) then `file`/`files`/`upload`/`document`. Retry-safe. |
| `POST` | `/resources/upload`, `/upload` | `files:write` | admin/super_admin role | Aliases of `POST /resources`. Also available under the bare `/api` prefix: `/api/resources`, `/api/resources/upload`, `/api/upload`. |
| `GET` | `/resources/:id` | `files:read` | — | Metadata, availability and endpoint URLs |
| `PATCH` | `/resources/:id` | `files:write` | admin/super_admin role | Edit metadata without re-uploading |
| `DELETE` | `/resources/:id` | `files:delete` | admin/super_admin role | Soft delete; `?permanent=1` also removes provider bytes |
| `GET` | `/resources/:id/access` | `files:read` | — | Mint short-lived preview + download URLs |
| `GET` | `/resources/:id/preview-url` | `files:read` | — | Short-lived inline URL, or `415` with a download URL for Office/unsupported types |
| `GET` | `/resources/:id/preview` | `files:read` | — | `302` to the signed inline URL |
| `GET` | `/resources/:id/download-url` / `/download` | `files:read` | — | Short-lived attachment URL / redirect |
| `GET` | `/resources/:id/content` | `files:read` | — | Authenticated byte stream with `Range` for a server-side proxy |
| `POST` | `/resources/bulk-download` | `files:read` | — | `{ "ids": [...] }` → streaming ZIP, per-file errors in headers and `_download-errors.txt` |
| `POST` | `/resources/:id/verify` | `files:write` | admin/super_admin role | One provider HEAD/get; updates availability |
| `POST` | `/resources/sync` | `files:write` | admin/super_admin role | On-demand reconciliation with a checkpoint cursor |
| `GET` | `/resources/counts` | `files:read` | — | Fast cached live counts for the landing page; 30s cache, no provider calls |
| `GET` | `/resources/health` | `files:read` | — | Database, provider and availability health; always includes `storage` + `reported: true` (no credentials) |
| `GET` | `/storage-status` | public | — | Redacted 9Drive storage declaration for admin panels; always includes `storage` + `reported: true` |

```bash
BASE=https://drive.example.com/api/v1
KEY=9d_live_…

curl -X POST "$BASE/resources" \
  -H "Authorization: Bearer $KEY" \
  -F 'resourceMeta={"title":"Cell Structure Notes","category":"Science","subject":"Biology","visibility":"students","provider":"s3","clientRequestId":"request-12345678","fileName":"biology.pdf","mimeType":"application/pdf","sizeBytes":"2048"}' \
  -F 'file=@biology.pdf;type=application/pdf'

# Equivalent aliases and plain-field form, useful when an existing admin client
# cannot be changed to send a resourceMeta JSON part:
#   POST "$BASE/resources/upload" or "$BASE/upload"
#   POST https://drive.example.com/api/resources/upload
curl -X POST "$BASE/resources/upload" \
  -H "Authorization: Bearer $KEY" \
  -F 'title=Cell Structure Notes' \
  -F 'category=Science' \
  -F 'size=2048' \
  -F 'provider=9drive' \
  -F 'clientRequestId=request-12345678' \
  -F 'file=@biology.pdf;type=application/pdf'

> **Upload troubleshooting.** A `4xx` from an unknown path is often displayed by
> a client as “storage is unavailable”. Use one of the aliases above, keep the
> same server-side API key with `files:write`, and make sure the key owner is an
> `admin`/`super_admin`. Metadata fields must precede the file part for the
> streaming parser. `provider=9drive` or `auto` means automatic routing, never a
> third cloud. Backblaze B2 bucket names are normalized to lowercase on read,
> so a stored `EDUBRIXVORA` no longer causes `NoSuchBucket`; still set the exact
> lowercase bucket name in Render for clarity. A real provider failure returns a
> structured `5xx` with a code and never a fake success.

curl -H "Authorization: Bearer $KEY" \
  "$BASE/resources?audience=student&subject=Biology&limit=20"

# Fast landing-page counts (cached 30s; no Drive/S3 calls)
curl -H "Authorization: Bearer $KEY" \
  "$BASE/resources/counts?audience=student"

curl -H "Authorization: Bearer $KEY" \
  "$BASE/resources/<id>/preview-url"

curl -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"ids":["<id1>","<id2>"]}' "$BASE/resources/bulk-download" -o resources.zip

# Admin status panel: `storage.reported` is true even when status is degraded.
curl -H "Authorization: Bearer $KEY" "$BASE/resources/health"
```

`GET /resources/health` response shape:

```json
{
  "status": "ok",
  "storage": {
    "status": "connected",
    "provider": "9Drive",
    "database": { "ok": true },
    "accounts": [{ "ok": true, "provider": "s3" }],
    "resources": { "available": 10, "missing": 0, "inaccessible": 0, "unknown": 0 },
    "checkedAt": "2026-11-02T12:00:00.000Z",
    "reported": true
  },
  "storageStatus": "connected",
  "reported": true
}
```

### Storage status is reported on every status endpoint

`GET /api/v1/storage-status` is public and redacted (no account emails, bucket
names, keys or object keys). Use it for an admin panel that currently says
“Storage status has not been reported by the API yet.”:

```bash
curl https://drive-edubrixvora-1.onrender.com/api/v1/storage-status
```

```json
{
  "storage": {
    "status": "connected",
    "provider": "9drive",
    "configured": "9drive",
    "reported": true,
    "persistence": "Persistent",
    "capacity": {
      "reported": false,
      "usedBytes": "0",
      "totalBytes": null,
      "availableBytes": null,
      "fileCapRemaining": null,
      "note": "At least one connected account does not report a quota, so capacity stays unknown rather than looking unlimited."
    },
    "accounts": { "connected": 7, "googleDrive": 4, "s3": 3 },
    "upload": {
      "available": true,
      "endpoint": "/api/v1/resources",
      "alternativeEndpoint": "/api/v1/files",
      "method": "POST",
      "requiredScope": "files:write",
      "maxBytes": "5368709120",
      "reason": null
    },
    "appRecords": "MySQL — accounts, file metadata & registry, not file bytes",
    "display": {
      "storageProvider": "9drive",
      "storageProviderNote": "9drive is the only destination for new file bytes",
      "configured": "9drive",
      "fileCapRemaining": "Capacity not reported",
      "persistence": "Persistent",
      "appRecords": "MySQL — accounts, file metadata & registry, not file bytes",
      "uploadEndpoint": "/api/v1/resources",
      "uploadAvailable": true
    },
    "checkedAt": "2026-11-02T12:00:00.000Z",
    "note": "9Drive is configured and reporting storage status; provider capacity is not reported."
  },
  "storageStatus": "connected",
  "storageReported": true,
  "reported": true,
  "checkedAt": "2026-11-02T12:00:00.000Z"
}
```

The same `storage`, `storageStatus` and `reported: true` fields are also present
on `GET /api/v1` (API index), `GET /health`, `GET /ready`,
`GET /api/diagnostics` (`storageStatus` / `storageReported`), `GET /api/v1/me`
and `GET /api/v1/usage`. `storage.upload` advertises whether an authenticated
upload can be routed right now, the canonical endpoint, the required scope and
the byte limit; a false value includes a safe reason. `GET /api/storage-status`
is a bare-`/api` alias. A degraded provider or an unreachable registry changes
`storage.status` to `degraded` / `unavailable`; it never removes `reported`.
Edvanta's own `/api/admin/overview` must pass this object through — see
[`docs/EDVANTA-INTEGRATION.md`](EDVANTA-INTEGRATION.md).

Visibility: `private` is only visible with `audience=admin`; `students` and
`public` are visible to students. A student listing returns only
`availability=available` by default. `previewSupported=false` still returns a
download URL. A missing/inaccessible object yields `410`/`502` rather than a
broken preview. Bulk limits are `RESOURCE_BULK_MAX_FILES` (25) and
`RESOURCE_BULK_MAX_BYTES` (512 MiB).

The full contract, role bootstrap, Render variables and manual cloud checklist
are in [`docs/EDVANTA-INTEGRATION.md`](EDVANTA-INTEGRATION.md), with a tested
copy-paste server client in [`examples/edvanta/`](../examples/edvanta/).

### Errors specific to resources

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `RESOURCE_META_INVALID` / `RESOURCE_CURSOR_INVALID` | Bad metadata or pagination token |
| 403 | `ROLE_FORBIDDEN` / `RESOURCE_PRIVATE` | Key owner lacks the role, or a student requested a private record |
| 409 | `RESOURCE_IDEMPOTENCY_CONFLICT` | Concurrent retry of the same `clientRequestId`; retry once |
| 410 | `RESOURCE_MISSING` | Metadata exists, provider object is gone |
| 413 | `BULK_TOO_MANY_FILES` / `BULK_TOO_LARGE` / `UPLOAD_TOO_LARGE` | Limit exceeded |
| 415 | `PREVIEW_UNSUPPORTED` | Office/unsupported type; the body carries a download URL |
| 502 | `RESOURCE_INACCESSIBLE` / `BULK_ALL_FILES_UNAVAILABLE` | Provider denied access or every selected file failed |
| 507 | `NO_ACCOUNT_WITH_ENOUGH_SPACE` | No connected provider can hold the upload |

## Deployment notes

- `PUBLIC_BASE_URL` pins the origin used in share and download URLs. Set it only
  when a proxy rewrites the `Host` header; by default the request's own origin is
  used.
- `SUPER_ADMIN_EMAILS` bootstraps administrator roles; `RESOURCE_URL_TTL_SECONDS`,
  `RESOURCE_BULK_MAX_FILES` and `RESOURCE_BULK_MAX_BYTES` cap capability URLs and
  ZIPs. `OBJECT_URL_SIGNING_SECRET` is optional (derived from
  `TOKEN_ENCRYPTION_KEY` when unset). See
  [`docs/EDVANTA-INTEGRATION.md`](EDVANTA-INTEGRATION.md).
- `API_RATE_LIMIT_PER_MINUTE=0` disables the limiter. `API_RATE_LIMIT_STORAGE=database`
  requires the additive `20261102140000_website_api_hardening` migration.
- `API_CORS_ORIGINS` optionally restricts browser origins; `REQUEST_TIMEOUT_MS`
  bounds long streaming uploads. New users default to `visitor`; promote the
  account that owns connected storage before creating the website key.
- Uploads are routed by the dashboard's routing policy (most available space,
  round-robin, or priority) on new keys. Overwrites stay on the recorded account.
- Object routes enforce API-key scopes and per-user ownership. They no longer
  require a dashboard admin role, so a valid website key keeps working if its
  owner is later demoted; API-key creation/rotation still requires an admin
  dashboard session. Provider failures return safe codes, never raw details.
- Requirement-by-requirement audit and manual acceptance checklist:
  [`docs/WEBSITE-API-AUDIT.md`](WEBSITE-API-AUDIT.md).
