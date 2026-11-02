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

A query parameter (`?api_key=9d_live_…`) is accepted for clients that cannot set
headers. Do not use it for anything a browser loads: the key would travel in the
URL, into logs and `Referer` headers. Use a share link instead.

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

Any origin may call these routes with a key. That is safe: the key is a bearer
token, so a browser never attaches one by itself, and `credentials` is off.
Dashboard routes (cookies) remain restricted to `FRONTEND_URL`.

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
| Requests | `API_RATE_LIMIT_PER_MINUTE` per key (600 by default) |
| Files per multipart request | 25 |

Rate-limit responses are `429` with `Retry-After`, and every response carries
`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`.

## Errors

Errors are JSON with a stable `code` and a message that names the cause.

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `API_KEY_REQUIRED` | No `Authorization` header |
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

## Deployment notes

- `PUBLIC_BASE_URL` pins the origin used in share and download URLs. Set it only
  when a proxy rewrites the `Host` header; by default the request's own origin is
  used.
- `API_RATE_LIMIT_PER_MINUTE=0` disables the limiter.
- Uploads are routed by the dashboard's routing policy (most available space,
  round-robin, or priority) unless the folder is pinned to an account.
