# 9Drive Website API — implementation audit

This document records the audit requested by the attached 3-page
*9Drive Website API — Required Changes & Implementation Specification*. It is a
change record for the existing repository, not a claim that live Google Drive/S3
operations or an Edvanta deployment were executed here.

## Scope

- **In scope:** one external website, one website API key, the existing
  `/api/v1/objects` API, existing `selectAccount()` routing, connected
  Google Drive / S3-compatible accounts, metadata in MySQL, secure
  file operations, and an integration example.
- **Out of scope:** a new project, a platform-owned bucket, a new storage
  backend, provider credentials on the website, multi-website tenancy, and any
  replacement of the existing storage integrations.
- No optional cloud preset was added. The already-connected accounts remain the
  only destinations for new file bytes.

## 1. Existing code reused

| Area | Reused behaviour |
| --- | --- |
| `objects.service.ts` | `putObject`, `listObjects`, `deleteObject`, `findObject`, upload session, checksum stream, provider verification, cleanup |
| `objects.routes.ts` | Secured website-facing object endpoints |
| `object-link.routes.ts` | Signed-link destination for browser reads/writes |
| `api-key.middleware.ts` | Bearer authentication, scope checks, ownership via `req.user.id`, rate limiting |
| `api-key.routes.ts` | Create/list/revoke; added regeneration |
| `object-signing.ts` | HMAC signature, method/key/expiry binding; added live signing identity |
| `s3/s3.service.ts`, `provider-operations.ts` | S3-compatible and Google Drive upload/download/HEAD/delete through the recorded account |
| `uploads/upload.routes.ts` | Existing `selectAccount()` and routing policy (`most_available`, `round_robin`, `priority`) |
| `schema.prisma` | Existing `ApiKey`, `ConnectedAccount`, `File`; one new optional rate-limit table |
| `examples/other-website/` | Copy-paste client, README, mocked tests |

## 2. Endpoint audit

| Method | Endpoint | Status after this change |
| --- | --- | --- |
| `PUT /api/v1/objects/{key}` | Implemented. `files:write`, ownership, `Content-Length`/`?sizeBytes`, `MAX_UPLOAD_BYTES`, streaming provider write, provider verification, checksum, retry-safe stable object key. | ✅ |
| `GET /api/v1/objects/{key}` | Implemented. `files:read`, ownership, `Range`, ETag/`If-None-Match`, safe inline allowlist, forced attachment for risky types. | ✅ |
| `HEAD /api/v1/objects/{key}` | Implemented. `files:read`, ownership, `Content-Type`/`Content-Length`/`ETag`/`Last-Modified`, `nosniff`. | ✅ |
| `DELETE /api/v1/objects/{key}` | Implemented. `files:delete`, ownership, provider delete using the recorded account, idempotent `204`, safe failure instead of fake success. | ✅ |
| `GET /api/v1/objects` | Implemented. Keyset pagination, `prefix`/`delimiter`, `q` name/metadata search, exact `checksum`, `mimeType`, richer metadata. | ✅ |
| `POST /api/v1/objects/sign` | Implemented. Scope check, short expiry, HMAC bound to user + live key identity + key + method + expiry; revocation/scope removal invalidates outstanding links. | ✅ |

## 3. Requirement-by-requirement changes

| PDF requirement | Change |
| --- | --- |
| No new bucket / reuse connected accounts | `putObject` still calls existing `selectAccount()`. No bucket model or provider preset added. |
| Header-only API key | Removed `?api_key=…`; it now returns `401 API_KEY_QUERY_NOT_ALLOWED`. `/api/v1` no longer advertises a query parameter. |
| Hash, show once, revoke/regenerate | Existing create/revoke kept. Added `POST /api/api-keys/:id/regenerate` and a dashboard **Rotate** button; transaction revokes old row and stores only the new hash. |
| Scopes on every request | `requireApiKey` still enforces `files:read`, `files:write`, `files:delete`; `POST /sign` rechecks the exact method scope; signed links recheck the live key scope. |
| Review `requireRole` in object routes | Removed `requireRole('manage_resources')` from object PUT/DELETE/sign. Object routes rely on bearer scopes + ownership, so a later role demotion does not break a valid website key. API-key creation/rotation and resource writes remain admin-guarded. |
| New upload routing | Existing `selectAccount()` filters connected accounts by provider support/capacity and applies the configured routing policy. |
| Save provider references | `File.userId`, `connectedAccountId`, `provider`, `providerFileId`, `objectKey`, `sizeBytes`, `mimeType`, `checksum`, timestamps are already stored; `PUT` now also returns checksum/name/createdAt/metadata. |
| Overwrite stays on recorded account | Strict pinning added. A disconnected/full account returns `409 STORAGE_ACCOUNT_UNAVAILABLE`; changing provider returns `409 OBJECT_PROVIDER_MIGRATION_UNSUPPORTED`. No silent migration. |
| Download/preview/delete use recorded account | `findObject`/`deleteObject` include `connectedAccount`; streams and `deleteProviderFile` resolve through `connectedAccountId`. No new account selection. |
| Unique keys / same display name | `objectKey` is unique per user, not filename. Added `buildUniqueObjectKey()` / `uniqueKey()` with a generated id segment and path-safe name. |
| Checksums / duplicate detection | MD5 is computed while streaming and stored. Listing now accepts `?checksum=<md5>` and returns `checksum` per object; kit exposes `findDuplicates()`. |
| Folders / prefixes | Existing `prefix` + `delimiter` retained; `objectKeyProblem()` rejects traversal, control chars, dot/empty segments. |
| Search / pagination | Added `q`, exact `checksum`, `mimeType`; existing keyset `continuation-token` retained. |
| Metadata | Listing returns `name`, `sizeBytes`, `mimeType`, `checksum`, `createdAt`, `lastModified`, `etag`, `metadata`. |
| Safe preview | Added `safeInlineMimeType()` allowlist, `nosniff`, sandbox CSP for inline, forced attachment for SVG/HTML/JS/Office/archive/unknown. |
| Signed URLs | HMAC now includes `k` (`api-key:<id>` or `resource:<id>`). The public handler verifies the live key/resource row, status, expiry and scope. |
| Large files | `MAX_UPLOAD_BYTES`, `REQUEST_TIMEOUT_MS`, streaming provider writes; no full-file buffering. |
| No credential leakage | Safe error mapper replaces raw provider/bucket/endpoint/email/token text in responses and logs. `selectAccount` quota logs no longer include account email. |
| Key validation | Existing `objectKeyProblem()` retained and unit-tested. |
| CORS | Added optional `API_CORS_ORIGINS` exact-origin restriction; documented that CORS is not authentication. |
| Rate limiting | `API_RATE_LIMIT_STORAGE=memory` default; optional `database` mode uses a shared table for multi-instance deployments. |
| Least-privilege role default | `User.role` default changed from `admin` to `visitor` for new accounts; registration and Google sign-in set `visitor` explicitly. Existing rows are not rewritten. |
| Upload failure cleanup | Existing provider-object cleanup and session/row status handling retained; failure messages/codes sanitized. |
| Docs + integration example | `docs/API.md`, `docs/EDVANTA-INTEGRATION.md`, `examples/other-website/README.md`, `drive-storage.mjs`, env examples, Render blueprint updated. |

## 4. Database

Additive migration: `backend/prisma/migrations/20261102140000_website_api_hardening/migration.sql`.

- `users.role` default becomes `visitor`. **Existing rows are not modified.**
- New `api_key_rate_limit_windows` table, used only when
  `API_RATE_LIMIT_STORAGE=database`.
- No platform-owned bucket model, no destructive migration, no backfill.

Apply on Render with the existing start command `npm run db:migrate:deploy`.
This was not applied to a live database from this workspace.

## 5. Render configuration

Required/new optional environment values:

```env
MAX_UPLOAD_BYTES=5368709120
REQUEST_TIMEOUT_MS=1800000
API_RATE_LIMIT_PER_MINUTE=600
API_RATE_LIMIT_STORAGE=memory          # database for multi-instance
API_CORS_ORIGINS=                      # exact origins when browser JS calls directly
SUPER_ADMIN_EMAILS=owner@example.com   # explicit admin bootstrap
OBJECT_URL_SIGNING_SECRET=             # optional; derived when empty
```

`render.yaml` and `backend/.env.example` include these values. No real secret is
committed. Keep `TOKEN_ENCRYPTION_KEY` stable; rotating it invalidates existing
encrypted credentials and derived signed-link secrets.

## 6. Verification performed here

Mocked/local only:

- `cd backend && npm test` — **29/29**, includes `tsc` and 8 new
  website/object-API tests.
- `cd frontend && npm run build` — typecheck, Vite build, nginx template check.
- `node --test examples/edvanta/*.test.mjs` — **22/22**; Python FastAPI helper
  **5/5**.
- `node --test examples/other-website/drive-storage.test.mjs` — **15/15**;
  wire-format, unique keys, checksum search, signed URL identity.
- `npx prisma validate` with the sandbox's no-engine workaround — valid.
- `git diff --check` — clean.

## 7. NOT verified here

- No live Google Drive or S3 upload/download/delete, quota refresh, OAuth or
  rate-limit behaviour.
- No real MySQL migration apply or multi-instance rate-limit run.
- No authenticated end-to-end upload from the external website or Edvanta UI.
- No Render deployment from this workspace; the branch must be merged/deployed
  and the migration applied before live acceptance checks.

## 8. Manual acceptance checklist

1. Apply the migration; confirm existing admins still have their stored role.
2. Create one website key with the required scopes; store it only server-side.
3. `PUT` an object with a generated unique key; confirm `201`, checksum and
   metadata, and that the bytes land in an already-connected account.
4. `PUT` a second object with the same display name but a different generated
   key; confirm both rows exist.
5. `GET /objects?checksum=<md5>`; confirm content-based duplicate lookup.
6. `GET` a PDF/image inline and an SVG/HTML/Office file as attachment.
7. `HEAD`, `GET` with `Range`, and `DELETE` use the recorded provider account.
8. Mint GET/HEAD/PUT signed links; confirm method/key/expiry binding. Revoke or
   down-scope the key and confirm outstanding links fail.
9. Confirm `?api_key=…`, invalid/revoked/expired keys and missing scopes are
   rejected; confirm another user's key cannot read/overwrite/delete these objects.
10. Disconnect or fill the recorded account and retry an overwrite; confirm a
    clear `409` rather than silent migration to another account.
11. With `API_RATE_LIMIT_STORAGE=database`, run two instances and confirm one
    shared budget. Set `API_CORS_ORIGINS` and confirm only the exact origin is
    allowed for browser requests.
12. Confirm no response/log contains raw provider errors, account emails,
    bucket names, tokens or internal paths.
