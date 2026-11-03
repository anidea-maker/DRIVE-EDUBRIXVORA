import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'prisma/config'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

/**
 * Prisma CLI configuration.
 *
 * The CLI normally connects with a bundled native engine. Turso is reached over
 * HTTP/WebSocket through the libSQL driver adapter instead, so every `prisma`
 * command here runs on the JavaScript schema engine (`engine: 'js'`) with the
 * same adapter and the same URL resolution the API uses at runtime:
 *
 *   npx prisma migrate deploy   -> applies prisma/migrations to Turso
 *   npx prisma migrate status   -> pending/applied migrations
 *   npx prisma generate         -> typed client (WASM compiler, nothing downloaded)
 *
 * Consequences worth knowing:
 *   - `backend/.env` is loaded here by hand, because a Prisma config file turns
 *     off the CLI's automatic .env loading.
 *   - The datasource URL in `schema.prisma` is not used by these commands; the
 *     adapter below is authoritative. It is still set from the same values so
 *     `prisma validate` / `generate` never complain about a missing variable.
 *   - `migrate dev` needs a shadow database. libSQL provides an in-memory one via
 *     the adapter, so it works locally; against Turso prefer `db:migrate:deploy`.
 *   - The URL rules live in `src/config/database-url.ts`, which the API also
 *     imports. This file re-implements only the two-line decision of *which*
 *     variable wins, because a Prisma config file cannot import a TypeScript
 *     module from `src/`. `prisma-run.mjs` and `db:check` print what was chosen.
 */

const backendDir = __dirname

function readEnvFile(): Map<string, string> {
  const file = path.join(backendDir, '.env')
  const values = new Map<string, string>()
  if (!fs.existsSync(file)) return values
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

// Same precedence as src/config/database-url.ts; the process environment always wins.
const fromFile = readEnvFile()
for (const key of ['DATABASE_URL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
  if (!process.env[key]?.trim()) {
    const value = fromFile.get(key)?.trim()
    if (value) process.env[key] = value
  }
}

const rawUrl = process.env.TURSO_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || 'file:./prisma/dev.db'
const authToken = process.env.TURSO_AUTH_TOKEN?.trim()

if (/^(mysql|mysqls|mariadb):\/\//i.test(rawUrl)) {
  console.error(
    [
      '',
      'DATABASE_URL still points at MySQL, but this build stores its data in SQLite/Turso.',
      'Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN instead',
      '(see backend/prisma/legacy-mysql/README.md).',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

/** Splits `?authToken=…` out of the URL so the token is never printed with it. */
function splitToken(url: string): { url: string; token?: string } {
  const questionMark = url.indexOf('?')
  if (questionMark === -1) return { url }
  const params = new URLSearchParams(url.slice(questionMark + 1))
  const token = params.get('authToken') ?? params.get('auth_token') ?? undefined
  params.delete('authToken')
  params.delete('auth_token')
  const rest = params.toString()
  return { url: rest ? `${url.slice(0, questionMark)}?${rest}` : url.slice(0, questionMark), token }
}

const normalized = rawUrl.startsWith('turso://') ? `libsql://${rawUrl.slice('turso://'.length)}` : rawUrl
const { url: databaseUrl, token: tokenFromUrl } = splitToken(normalized)
const databaseAuthToken = authToken ?? tokenFromUrl

const isLocal = databaseUrl.startsWith('file:') || databaseUrl.startsWith(':memory:')

// `prisma validate` / `prisma generate` only need the variable to exist.
process.env.DATABASE_URL = databaseUrl
if (databaseAuthToken) process.env.TURSO_AUTH_TOKEN = databaseAuthToken

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // Required by Prisma 6 when the JS schema engine is used.
  experimental: { adapter: true },
  engine: 'js',
  adapter: async () =>
    new PrismaLibSQL({
      url: databaseUrl,
      ...(!isLocal && databaseAuthToken ? { authToken: databaseAuthToken } : {}),
    }),
})
