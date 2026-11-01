#!/usr/bin/env node
/**
 * Runs the Prisma CLI with the right environment - used by every `prisma:*` and
 * `db:*` npm script.
 *
 * Two things the plain `prisma` binary cannot do on its own:
 *
 *  1. A platform-injected `DATABASE_URL` overrides `backend/.env`, and Prisma's
 *     MySQL connector only reads TLS settings from the URL. So when the provider
 *     CA arrives as `DATABASE_CA_CERT`, this process writes it to
 *     `prisma/certs/db-ca.pem` and rewrites `DATABASE_URL` to
 *     `?sslcert=certs/db-ca.pem&sslaccept=strict` *before* spawning Prisma.
 *     Without this, `prisma migrate deploy` connects unencrypted and Aiven (and
 *     most managed MySQL servers) reject it.
 *
 *  2. Prisma resolves `sslcert` relative to `backend/prisma`, so the child is
 *     spawned with `backend/` as its working directory regardless of where the
 *     npm script was invoked from.
 *
 * Usage: node scripts/prisma-run.mjs generate
 *        node scripts/prisma-run.mjs migrate deploy
 *        node scripts/prisma-run.mjs migrate status
 */
import { spawnSync } from 'node:child_process'
import { backendDir, applyCaCertificate, readEnv, readEnvFile } from './lib/env-config.mjs'

const args = process.argv.slice(2)

if (args.length === 0) {
  console.error('Usage: node scripts/prisma-run.mjs <command> [args...]  e.g. migrate deploy')
  process.exit(2)
}

// backend/.env is only consulted when the variable is not already injected.
if (!process.env.DATABASE_URL) {
  const fromFile = readEnv(readEnvFile()).get('DATABASE_URL')
  if (fromFile) process.env.DATABASE_URL = fromFile
}

const ca = applyCaCertificate()
if (ca.pemWritten) {
  console.log('[prisma] Database CA certificate written to prisma/certs/db-ca.pem')
}
if (ca.patched) {
  console.log('[prisma] DATABASE_URL uses sslcert=certs/db-ca.pem&sslaccept=strict')
}
if (ca.pemWritten && !ca.patched) {
  console.warn(
    '[prisma] DATABASE_CA_CERT was supplied but DATABASE_URL has no sslcert - add\n' +
      '         ?sslcert=certs/db-ca.pem&sslaccept=strict to it (or use a mysql:// URL).',
  )
}

const result = spawnSync('prisma', args, {
  cwd: backendDir,
  stdio: 'inherit',
  env: process.env,
})

if (result.error) {
  console.error(`[prisma] Failed to start the Prisma CLI: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
