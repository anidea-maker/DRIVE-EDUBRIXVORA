import dotenv from 'dotenv'
import path from 'node:path'
import { applyDatabaseCaCert } from './database-ca.js'

let loaded = false

/**
 * Loads `backend/.env` into `process.env`.
 *
 * Resolved from this file's location (so it works from `src/` under tsx and from
 * `dist/` after a build, whatever the current working directory is), then falls
 * back to the default `.env` lookup in the cwd. Existing environment variables
 * always win, which keeps Docker/PM2/PaaS secrets authoritative.
 *
 * Afterwards, an inline `DATABASE_CA_CERT` (PEM/base64) is materialized into
 * `prisma/certs/db-ca.pem` and wired into `DATABASE_URL` for verified TLS.
 */
export function loadEnvFiles(): void {
  if (loaded) return
  loaded = true

  dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true })
  dotenv.config({ quiet: true })
  applyDatabaseCaCert()
}
