import path from 'node:path'

/**
 * One place that decides *which* SQLite database this process talks to.
 *
 * Both the running API (`src/config/prisma.ts`) and the Prisma CLI
 * (`prisma.config.ts`) import this file, so `npm run db:migrate:deploy` and the
 * server can never disagree about the target.
 *
 * Accepted, in order:
 *
 *   1. `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` - what the Turso dashboard and
 *      `turso db show` print. This is the recommended pair.
 *   2. `DATABASE_URL` alone - a `libsql://`, `https://`, `turso://`, `file:` or
 *      `:memory:` URL. A Turso URL may carry `?authToken=...`; it is parsed out
 *      and removed from the URL so the token never appears in logs.
 *   3. Nothing set -> `backend/prisma/dev.db`, so `npm run dev` works offline
 *      without a Turso account. `.gitignore` already excludes `*.db`.
 *
 * A keep-alive of the old MySQL deployment is not supported: this app now stores
 * its schema in SQLite. Point DATABASE_URL at a MySQL server and startup fails
 * with an explanation instead of a confusing driver error.
 */

export type DatabaseConfig = {
  /** URL handed to @libsql/client (`libsql://`, `https://`, `file:` or `:memory:`). */
  url: string
  /** Turso auth token, if this deployment needs one. Never logged. */
  authToken?: string
  /** `remote` for Turso, `file` for a local database, `memory` for `:memory:`. */
  kind: 'remote' | 'file' | 'memory'
}

export const DEFAULT_LOCAL_DATABASE = {
  url: 'file:./prisma/dev.db',
  file: path.resolve(__dirname, '..', '..', 'prisma', 'dev.db'),
}

/** A MySQL URL is a leftover from the Aiven deployment, not a usable target. */
const MYSQL_PROTOCOL = /^(?:mysql|mysqls|mariadb):\/\//i

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseUrlError'
  }
}

function trim(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Pulls `authToken` out of a query string. @libsql/client accepts it as a URL
 * parameter too, but keeping it in a separate field means the URL can be printed
 * (health output, `db:check`) without leaking the token.
 */
function splitAuthToken(url: string): { url: string; authToken?: string } {
  const questionMark = url.indexOf('?')
  if (questionMark === -1) return { url }

  const base = url.slice(0, questionMark)
  const params = new URLSearchParams(url.slice(questionMark + 1))
  const authToken = params.get('authToken') ?? params.get('auth_token') ?? undefined
  params.delete('authToken')
  params.delete('auth_token')
  const rest = params.toString()
  return { url: rest ? `${base}?${rest}` : base, authToken }
}

function classify(url: string): DatabaseConfig['kind'] {
  if (url === ':memory:' || url.startsWith(':memory:')) return 'memory'
  if (url.startsWith('file:')) return 'file'
  return 'remote'
}

/**
 * Normalizes one raw URL into a libsql URL.
 *
 * `turso://` is what the Turso dashboard's "connect" dialog shows for some
 * databases; @libsql/client only understands `libsql://` and `https://`, so the
 * scheme is rewritten rather than rejected.
 */
function normalizeRemote(url: string): string {
  if (url.startsWith('turso://')) return `libsql://${url.slice('turso://'.length)}`
  return url
}

export function resolveDatabaseConfig(source: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const databaseUrl = trim(source.DATABASE_URL)
  const tursoUrl = trim(source.TURSO_DATABASE_URL)
  const tursoToken = trim(source.TURSO_AUTH_TOKEN)

  const raw = tursoUrl ?? databaseUrl

  if (!raw) {
    return { url: DEFAULT_LOCAL_DATABASE.url, kind: 'file' }
  }

  if (MYSQL_PROTOCOL.test(raw)) {
    throw new DatabaseUrlError(
      [
        'DATABASE_URL still points at MySQL, but this build stores its data in SQLite/Turso.',
        '',
        'Set the Turso connection instead:',
        '  TURSO_DATABASE_URL="libsql://<database>-<org>.turso.io"',
        '  TURSO_AUTH_TOKEN="<token from `turso db tokens create <database>`>"',
        '',
        'or point DATABASE_URL at a libsql URL, e.g.',
        '  DATABASE_URL="libsql://<database>-<org>.turso.io?authToken=<token>"',
        '',
        'Moving existing rows from Aiven: see backend/prisma/legacy-mysql/README.md.',
      ].join('\n'),
    )
  }

  const isFile = raw.startsWith('file:') || raw.startsWith(':memory:')
  if (!isFile && !/^(?:libsql|https?|wss?|turso):\/\//i.test(raw)) {
    throw new DatabaseUrlError(
      `DATABASE_URL must be a libsql://, https://, turso:// or file: URL. Got: ${maskDatabaseUrl(raw)}`,
    )
  }

  const normalized = isFile ? raw : normalizeRemote(raw)
  const { url, authToken } = splitAuthToken(normalized)
  const token = tursoToken ?? authToken

  if (!isFile && !token) {
    throw new DatabaseUrlError(
      [
        `Remote database ${maskDatabaseUrl(url)} needs an auth token.`,
        '',
        'Set TURSO_AUTH_TOKEN (create one with `turso db tokens create <database>`), or',
        'pass it in the URL as ?authToken=... .',
      ].join('\n'),
    )
  }

  if (isFile && /^libsql:\/\//.test(url)) {
    throw new DatabaseUrlError('A file: URL and a libsql:// URL cannot be combined.')
  }

  return { url, authToken: isFile ? undefined : token, kind: classify(url) }
}

/** Returns the URL or a readable message; used by scripts that must not throw at import time. */
export function tryResolveDatabaseConfig(source: NodeJS.ProcessEnv = process.env):
  | { ok: true; config: DatabaseConfig }
  | { ok: false; error: Error } {
  try {
    return { ok: true, config: resolveDatabaseConfig(source) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/** Safe to print: drops credentials and the auth token, keeps host and path. */
export function maskDatabaseUrl(url: string): string {
  if (url.startsWith('file:') || url === ':memory:') return url
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '********'
    if (parsed.searchParams.has('authToken')) parsed.searchParams.set('authToken', '********')
    return parsed.toString()
  } catch {
    return url.replace(/(authToken=)[^&]+/i, '$1********')
  }
}

/** Expands `file:./prisma/dev.db` to an absolute path for diagnostics. */
export function localDatabaseFile(url: string): string | null {
  if (!url.startsWith('file:')) return null
  const relative = url.slice('file:'.length)
  if (!relative || relative.startsWith('/')) return null
  return path.resolve(__dirname, '..', '..', relative.replace(/^\.\//, ''))
}
