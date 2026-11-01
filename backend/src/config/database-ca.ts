import fs from 'node:fs'
import path from 'node:path'

/** Env vars that may carry the database CA certificate (PEM contents, base64, or a file path). */
const CA_ENV_KEYS = ['DATABASE_CA_CERT', 'DATABASE_SSL_CA'] as const

/** Prisma resolves `sslcert=` relative to the `backend/prisma` folder. */
const PRISMA_DIR = path.resolve(__dirname, '..', '..', 'prisma')
const CA_FILE = path.join(PRISMA_DIR, 'certs', 'db-ca.pem')
const CA_FILE_FOR_URL = 'certs/db-ca.pem'

/**
 * Runs once. `DATABASE_CA_CERT` exists so the certificate can be supplied as an
 * environment variable on platforms that only offer an env-var form (Render,
 * Railway, Fly, Aiven's console, ...) - no file upload required.
 *
 * Accepted forms:
 *   - the PEM text itself (multiline or with literal \n escapes)
 *   - base64 of the PEM
 *   - a path to an existing .pem file
 *
 * The certificate is written to `prisma/certs/db-ca.pem` (the folder Prisma
 * resolves `sslcert` against) and the TLS parameters are added to
 * `process.env.DATABASE_URL`: `sslaccept=strict` plus `sslcert=certs/db-ca.pem`,
 * while the useless `ssl-mode` / `sslmode` parameters are dropped.
 */
export function applyDatabaseCaCert(): void {
  const raw = CA_ENV_KEYS.map((key) => process.env[key]).find((value) => value?.trim())
  const databaseUrl = process.env.DATABASE_URL?.trim()

  if (!raw || !databaseUrl?.startsWith('mysql://')) return

  const pem = normalizePem(raw)
  if (!pem) {
    console.warn(
      `[db-tls] ${CA_ENV_KEYS[0]} was set but no "BEGIN CERTIFICATE" block was found - ` +
        'paste the whole ca.pem file (or its base64) and try again.',
    )
    return
  }

  try {
    fs.mkdirSync(path.dirname(CA_FILE), { recursive: true })
    if (!fs.existsSync(CA_FILE) || fs.readFileSync(CA_FILE, 'utf8') !== pem) {
      fs.writeFileSync(CA_FILE, pem, { mode: 0o600 })
      console.log(`[db-tls] Wrote the CA certificate to ${path.relative(process.cwd(), CA_FILE)}`)
    }
  } catch (error) {
    console.warn(
      `[db-tls] Could not write ${CA_FILE}: ${(error as Error).message}. ` +
        'Set sslcert= manually in DATABASE_URL instead.',
    )
    return
  }

  const url = new URL(databaseUrl)
  if (url.searchParams.get('sslcert')) return

  url.searchParams.delete('ssl-mode')
  url.searchParams.delete('sslmode')
  url.searchParams.set('sslcert', CA_FILE_FOR_URL)
  url.searchParams.set('sslaccept', 'strict')
  process.env.DATABASE_URL = rebuildUrl(url)
  console.log('[db-tls] DATABASE_URL now uses sslcert=certs/db-ca.pem&sslaccept=strict')
}

/**
 * Rebuilds the URL without percent-encoding query values, so `sslcert` stays
 * `certs/db-ca.pem` instead of `certs%2Fdb-ca.pem` (Prisma resolves it as a path).
 */
function rebuildUrl(url: URL): string {
  const credentials = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : ''
  const query = [...url.searchParams.entries()].map(([key, value]) => `${key}=${value}`).join('&')
  return `${url.protocol}//${credentials}${url.host}${url.pathname}${query ? `?${query}` : ''}`
}

function normalizePem(value: string): string | null {
  const trimmed = value.trim()

  // Form 1: a path to an existing file.
  if (!trimmed.includes('BEGIN') && (trimmed.endsWith('.pem') || trimmed.endsWith('.crt'))) {
    try {
      const fromFile = fs.readFileSync(path.resolve(process.cwd(), trimmed), 'utf8')
      if (fromFile.includes('BEGIN CERTIFICATE')) return toPem(fromFile)
    } catch {
      // not a readable path - fall through to base64/PEM handling
    }
  }

  // Form 2: base64 (single long line, no dashes).
  if (!trimmed.includes('-----') && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
      if (decoded.includes('BEGIN CERTIFICATE')) return toPem(decoded)
    } catch {
      // not base64 - fall through
    }
  }

  // Form 3: the PEM text, possibly with escaped newlines.
  if (trimmed.includes('BEGIN CERTIFICATE')) {
    return toPem(trimmed.replace(/\\n/g, '\n'))
  }

  return null
}

/** Keeps only the certificate blocks, with exactly one trailing newline. */
function toPem(text: string): string {
  const blocks = text.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g)
  if (!blocks) return ''
  return `${blocks.join('\n')}\n`
}

export const databaseCaFile = CA_FILE
export const databaseCaFileForUrl = CA_FILE_FOR_URL
