# Moving an existing deployment from Aiven (MySQL) to Turso

The application schema now targets **SQLite via libSQL/Turso**. The old MySQL
migrations are kept here, unmodified, for reference and for exporting data:

```
prisma/legacy-mysql/migrations/…   the MySQL migration history (provider "mysql")
```

They are **not** run any more. `prisma/migrations/` contains the SQLite schema that
`npm run db:migrate:deploy` applies to Turso (or to a local `file:` database).

## What changed in the schema

| MySQL | Turso / SQLite |
| --- | --- |
| `@db.Char(36)`, `@db.VarChar(n)`, `@db.Text` | plain `String` (SQLite types are affinity hints) |
| `Json` columns (`scopes`, `priority_account_ids`, `resource_metadata`, `audit_logs.metadata`) | `TEXT` holding JSON, converted by `backend/src/utils/json-column.ts` |
| `DATETIME(3)` | `DATETIME`; Prisma stores ISO-8601 strings |
| `BIGINT` (file sizes) | `BIGINT`; values round-trip exactly through the libSQL adapter |
| InnoDB foreign keys + `ON DELETE CASCADE` | SQLite foreign keys, enforced because the libSQL client and Turso Cloud run `PRAGMA foreign_keys = ON` (asserted at boot) |

Table names, column names and application behaviour are unchanged, so API clients,
the dashboard and the Edvanta integration keep working.

## 1. Create the Turso database

```bash
turso auth login
turso db create 9drive                     # pick a region close to the API host
turso db show 9drive --url                 # libsql://9drive-<org>.turso.io
turso db tokens create 9drive              # the auth token
```

Set them on the API service (Render: *Environment*):

```bash
TURSO_DATABASE_URL=libsql://9drive-<org>.turso.io
TURSO_AUTH_TOKEN=<token>
```

Locally, put the same two lines in `backend/.env`, then:

```bash
cd backend
npm run db:check                # verifies URL, token, foreign keys, tables
npm run db:migrate:deploy       # creates the schema in Turso
```

`db:migrate:deploy` also runs automatically when the container boots.

## 2. Export the Aiven data

Rows, not schema. Do this from a machine that can reach Aiven (or from the Aiven
console's query window, one table at a time).

```bash
# MySQL client; one JSON file per table, dates as ISO strings
mysqldump \
  --host=<host> --port=<port> --user=avnadmin --password \
  --ssl-mode=REQUIRED --no-create-info --skip-extended-insert \
  --complete-insert --compact --compatible=ansi \
  --default-character-set=utf8mb4 \
  defaultdb users user_sessions auth_handoffs provider_configs oauth_states \
  connected_accounts s3_storage_configs storage_accounts files file_shares \
  file_preview_tokens folders upload_sessions audit_logs workspace_invites \
  api_keys api_key_rate_limit_windows upload_routing_policies \
  > 9drive-data.sql
```

A plain SQL dump is not the easiest format to import into SQLite (backticks,
`\n` escapes, `0/1` booleans, `JSON` values). The reliable path is a small script
that reads from MySQL with `mysql2` and writes with `@libsql/client`; it must:

1. insert parents before children
   (`users` → `provider_configs`/`connected_accounts` → `folders`/`files` → the rest);
2. convert `scopes` and `priority_account_ids` to JSON text
   (`JSON.stringify`) and `metadata`/`resource_metadata` likewise;
3. convert booleans to `0`/`1`;
4. keep `created_at`/`updated_at` in ISO-8601 (`new Date(value).toISOString()`);
5. copy `BIGINT` sizes as strings, so no precision is lost.

Then verify with `npm run db:check` (table count) and `GET /ready` (migration and
connection state).

## 3. Things to watch

- **Google/S3 credentials** are encrypted with `TOKEN_ENCRYPTION_KEY`. Copy the value
  from the old deployment unchanged, or every stored token becomes unreadable.
- **Passwords** are Argon2 hashes; they move as-is, so existing logins keep working.
- **Rate-limit windows** (`api_key_rate_limit_windows`) can be skipped safely; they
  are per-minute counters.
- **files.provider_file_id** values keep pointing at the same Google Drive/S3
  objects. No bytes move; only metadata moves.
- **Timestamps** are stored without a timezone. Export them as UTC (the MySQL
  server's `time_zone = '+00:00'` or a session `SET time_zone = '+00:00'`).
- **Aiven shutdown**: keep it running until the new deployment has served a few
  real requests, then delete the service.

## Rollback

Before the cut-over, the previous MySQL code is intact in `git` history
(`git show <commit-before-this-change>:backend/prisma/schema.prisma`). Rolling back
means redeploying that commit and pointing `DATABASE_URL` back at Aiven; nothing in
Turso is destroyed by doing so.
