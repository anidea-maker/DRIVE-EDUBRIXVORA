# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

`AGENTS.md` (imported above) holds the conventions, security rules, env vars, and API list. This file adds what it leaves out, and notes where the code has moved past it.

## Commands

Neither package has a test runner or linter. Verification means running the type-check/build:

- `cd backend && npm run build` (`tsc`)
- `cd frontend && npm run build` (`tsc && vite build`)

Other scripts that `AGENTS.md` doesn't list:

- `cd backend && npm run start:deploy`: `prisma migrate deploy`, then start. For production, never use `migrate reset` there.
- `cd backend && npm run test:s3` / `npm run test:api-upload`: manual smoke scripts in `backend/src/scripts/`.
- `setup.sh` / `setup.ps1`: create `backend/.env` and `frontend/.env` with random secrets, run `npm install`, and generate the Prisma client.
- `cd backend && npm run env:setup` (`node scripts/ensure-env.mjs`): creates `backend/.env` from `backend/.env.example` when it is missing, or appends only the missing keys to an incomplete one. Every `dev`, `start`, `prisma:*`, and seed script runs it first, so Prisma never hits `P1012 Environment variable not found: DATABASE_URL`. If `DATABASE_URL` is already exported (Docker, PM2, PaaS), it writes nothing. Manual `npx prisma ...` calls skip it, so run `npm run env:setup` once first.
- `cd backend && npm run db:check`: prints the masked `DATABASE_URL`, checks TCP reachability, warns about errors Prisma MySQL ignores (`ssl-mode`/`sslmode`) and about `sslaccept=strict` without `sslcert`, then runs a query.
- `cd backend && npm run db:status`: `prisma migrate status`.
- Hosted MySQL (Aiven and friends): use `?sslaccept=accept_invalid_certs`, or `?sslcert=certs/aiven-ca.pem&sslaccept=strict` with the CA in `backend/prisma/certs/` (git-ignored; `sslcert` resolves relative to `backend/prisma`). On env-var-only platforms set `DATABASE_CA_CERT` (PEM text, base64, or a path): `src/config/database-ca.ts` writes it to `prisma/certs/db-ca.pem` and rewrites `process.env.DATABASE_URL`, while `scripts/ensure-env.mjs` does the same into `backend/.env` so the Prisma CLI sees it. Use `npm run db:migrate:deploy`, not `migrate dev` - no shadow database. With Docker use `docker-compose.external-db.yml`.
- On Windows, if `prisma generate` fails because a file is locked, stop the running dev servers first.

## Architecture beyond AGENTS.md

**Two storage providers.** `ConnectedAccount.provider` is `google_drive` or `s3`. An S3-compatible account is a `ConnectedAccount` plus an `S3StorageConfig` row (encrypted keys, bucket, optional endpoint, `prefix` defaulting to `9drive`, optional `quotaBytes`). Code that touches a stored file has to branch on provider:
- Streaming: `modules/files/stream-file.ts` (`streamProviderFile`) sends work to `stream-google-file.ts` or `s3/s3.service.ts`.
- Quota: `syncGoogleQuota` (google.service) vs `syncS3Quota` (s3.service). Both write to `StorageAccount`.
- Upload: `ensureGoogleAppFolder` + Drive resumable upload vs `buildS3ObjectKey` + `uploadS3Object` (`@aws-sdk/lib-storage`).

**Upload routing** (`modules/uploads/upload.routes.ts`, `selectAccount`):
1. Re-sync quota for any account whose last sync is more than 5 minutes old.
2. Subtract bytes already reserved by earlier files in the same multipart request.
3. Apply the user's `UploadRoutingPolicy` mode: `most_available` (default), `round_robin` (cursor kept in the DB), or `priority` (`priorityAccountIds`).
4. If `availableBytes` is null, treat the account as unlimited. When quotas are unknown, S3 accounts are preferred.

`handleUpload` is shared with the external API, mounted as `POST /api/v1/uploads` (`modules/public-api`). That route is guarded by `requireApiKey('files:upload')` in `middleware/api-key.middleware.ts`, not by `requireAuth`. API keys are stored hashed and carry scopes.

**Virtual vs physical.** Folders exist only in MySQL (`Folder.parentId` tree). Files are stored flat in the provider's `9drive` folder or prefix. `File.folderId` is purely app-side. Folders and files are soft-deleted (`deletedAt`/`status`), which is what the Trash and Archived pages rely on.

**Google OAuth config comes from the DB, not env.** `env.ts` doesn't read `GOOGLE_*`. Those vars are read only by the seed scripts, which write a global `ProviderConfig` row (`userId` null) with encrypted credentials. It can also be set in Settings via `POST /system/google-config`. In Docker, `seed:google-config:docker` skips seeding when the credentials are blank or placeholders.

**Other modules missing from AGENTS.md:** `api-keys`, `audit-logs` (`utils/audit.ts` `createAuditLog`, shown on ActivityLogPage), `system` (self-update that runs `update.sh` from the repo root and falls back to `git pull`, `update-log`, `google-config`, backup/restore), and `s3`.

**Backend module style.** The backend is ESM with `module: NodeNext`, so relative imports need a `.js` suffix even in `.ts` files. Most route files hold their logic inline; services exist only for provider integrations (`google/`, `s3/`). Token encrypt/hash helpers are in `utils/crypto.ts`.

**Frontend API base URL.** `lib/api.ts` uses `VITE_API_URL` unless it's unset or still the default `http://localhost:4000`. In that case a production build falls back to `/api`, which `frontend/nginx.conf.template` proxies to `$API_UPSTREAM` with request buffering off so streamed uploads work. The template is rendered by the nginx image entrypoint (`frontend/docker-entrypoint.sh` normalizes `API_UPSTREAM`: `https://` for public FQDNs, `http://` for bare service names; it also refuses an `API_UPSTREAM` that points at the container itself, which otherwise loops `/api/x` -> `/x` and returns 405), it listens on `$PORT` (Render/Cloud Run inject their own), resolves the upstream per request via `resolver` so an unreachable backend cannot stop nginx from booting, and exposes `/healthz` for platform health checks. Upload queue and progress state live in `context/UploadContext.tsx`. The PWA service worker (`vite.config.ts`) has a `navigateFallbackDenylist` of backend path prefixes, so add any new top-level backend route there.
