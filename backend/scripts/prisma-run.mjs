#!/usr/bin/env node
/**
 * Runs the Prisma CLI with the right environment - used by every `prisma:*` and
 * `db:*` script.
 *
 * Why a wrapper instead of calling `prisma` directly:
 *
 *  1. Prisma CLI commands in this project run through `prisma.config.ts`, which
 *     needs `backend/.env` loaded (a config file disables the CLI's own .env
 *     loading) and needs to fail with a readable message when no Turso
 *     credentials are configured, instead of Prisma's opaque P1012.
 *  2. Prisma resolves the config file relative to this package, so the child must
 *     run from `backend/`.
 *  3. `db:migrate:deploy` on a fresh Turso database has nothing to migrate *from*;
 *     the wrapper prints the target and the migration count so a deploy log shows
 *     which database was touched.
 *
 * Usage: node scripts/prisma-run.mjs generate
 *        node scripts/prisma-run.mjs migrate deploy
 *        node scripts/prisma-run.mjs migrate status
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

process.chdir(backendDir)

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: node scripts/prisma-run.mjs <command> [args...]  e.g. migrate deploy')
  process.exit(1)
}

const command = args[0]

/** Reads backend/.env without a dependency; existing process env wins. */
function readEnvFile() {
  const file = path.join(backendDir, '.env')
  if (!fs.existsSync(file)) return new Map()
  const map = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    map.set(match[1], value)
  }
  return map
}

const fromFile = readEnvFile()
for (const key of ['DATABASE_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
  if (!process.env[key]?.trim()) {
    const value = fromFile.get(key)?.trim()
    if (value) process.env[key] = value
  }
}

const target = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL
if (target && !/^(mysql|mysqls|mariadb):\/\//i.test(target.trim())) {
  const masked = target.replace(/(authToken=)[^&]+/i, '$1********')
  console.log(`[prisma] Target ${masked}`)
} else if (target) {
  console.error(
    '[prisma] Refusing to run: DATABASE_URL/TURSO_DATABASE_URL still points at MySQL.\n' +
      '         Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (see backend/prisma/legacy-mysql/README.md).',
  )
  process.exit(1)
}

if (command === 'migrate' && args[1] === 'deploy') {
  const dir = path.join(backendDir, 'prisma', 'migrations')
  const count = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory()).length
    : 0
  console.log(`[prisma] Applying ${count} migration(s) from prisma/migrations`)
}

const binary = process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
const result = spawnSync(binary, args, {
  cwd: backendDir,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error(`[prisma] Failed to start the Prisma CLI: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
