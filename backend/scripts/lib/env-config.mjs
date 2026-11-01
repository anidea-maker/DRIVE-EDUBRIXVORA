/**
 * Shared environment helpers for the CLI scripts (`ensure-env.mjs`,
 * `prisma-run.mjs`).
 *
 * Key fact behind the CA handling: a `DATABASE_URL` injected by the platform
 * always wins over `backend/.env`, and Prisma's CLI only reads TLS settings from
 * the URL itself. So `DATABASE_CA_CERT` has to be turned into
 * `?sslcert=…&sslaccept=strict` **in the process that runs Prisma**, not just in
 * a .env file. `applyCaCertificate()` does that mutation in place.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const envPath = path.join(backendDir, '.env')

/** Prisma resolves `sslcert=` relative to `backend/prisma`. */
export const CA_FILE = path.join(backendDir, 'prisma', 'certs', 'db-ca.pem')
export const CA_FILE_FOR_URL = 'certs/db-ca.pem'
export const CA_ENV_KEYS = ['DATABASE_CA_CERT', 'DATABASE_SSL_CA']

/** Minimal .env parser: key -> value, ignoring comments and export prefixes. */
export function readEnv(contents) {
  const keys = new Map()
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim().replace(/^export\s+/, '')
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/s, '$2')
    keys.set(key, value)
  }
  return keys
}

/** Replaces `KEY=...` in place, keeping comments and ordering. */
export function setEnvValue(contents, key, value) {
  const pattern = new RegExp(`^\\s*(export\\s+)?${key}\\s*=.*$`, 'm')
  const line = `${key}="${value}"`
  if (pattern.test(contents)) return contents.replace(pattern, line)
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${line}\n`
}

/** Reads `backend/.env` (empty string when absent). */
export function readEnvFile() {
  return fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
}

/** Accepts PEM text (escaped newlines ok), base64 of a PEM, or a path to one. */
export function normalizePem(value) {
  const trimmed = value.trim()

  if (!trimmed.includes('BEGIN') && /\.(pem|crt)$/i.test(trimmed)) {
    try {
      const fromFile = fs.readFileSync(path.resolve(process.cwd(), trimmed), 'utf8')
      if (fromFile.includes('BEGIN CERTIFICATE')) return toPem(fromFile)
    } catch {
      // not a readable path - keep trying other shapes
    }
  }

  if (!trimmed.includes('-----') && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
    if (decoded.includes('BEGIN CERTIFICATE')) return toPem(decoded)
  }

  if (trimmed.includes('BEGIN CERTIFICATE')) return toPem(trimmed.replace(/\\n/g, '\n'))

  return ''
}

function toPem(text) {
  const blocks = text.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g)
  return blocks ? `${blocks.join('\n')}\n` : ''
}

/** Writes the PEM to prisma/certs/db-ca.pem. Returns the path, or null on failure. */
export function writeCaFile(pem) {
  try {
    fs.mkdirSync(path.dirname(CA_FILE), { recursive: true })
    fs.writeFileSync(CA_FILE, pem, { mode: 0o600 })
    return CA_FILE
  } catch (error) {
    console.warn(`[env] Could not write ${CA_FILE}: ${error.message}`)
    return null
  }
}

/**
 * Adds `sslcert=<CA_FILE_FOR_URL>` + `sslaccept=strict` to a MySQL URL and drops
 * the parameters Prisma ignores (`ssl-mode`, `sslmode`). Values are kept
 * unencoded so `sslcert` stays a usable relative path.
 */
export function withCaCert(databaseUrl) {
  let url
  try {
    url = new URL(databaseUrl)
  } catch {
    return databaseUrl
  }
  if (url.protocol !== 'mysql:') return databaseUrl

  url.searchParams.delete('ssl-mode')
  url.searchParams.delete('sslmode')
  url.searchParams.set('sslcert', CA_FILE_FOR_URL)
  url.searchParams.set('sslaccept', 'strict')

  const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  const query = [...url.searchParams.entries()].map(([key, value]) => `${key}=${value}`).join('&')
  return `${url.protocol}//${credentials}${url.host}${url.pathname}${query ? `?${query}` : ''}`
}

/** True when a CA was supplied through the environment. */
export function caValueFromEnv() {
  return CA_ENV_KEYS.map((key) => process.env[key]).find((value) => value?.trim())
}

/**
 * Materializes `DATABASE_CA_CERT` and patches `process.env.DATABASE_URL` in this
 * process, so a child `prisma` invocation inherits verified TLS.
 *
 * Returns { pemWritten, patched, url } describing what happened.
 */
export function applyCaCertificate(currentUrl = process.env.DATABASE_URL) {
  const raw = caValueFromEnv()
  if (!raw) return { pemWritten: false, patched: false, url: currentUrl }

  const pem = normalizePem(raw)
  if (!pem) {
    console.warn(
      `[env] ${CA_ENV_KEYS[0]} is set but contains no "BEGIN CERTIFICATE" block - ignoring it.`,
    )
    return { pemWritten: false, patched: false, url: currentUrl }
  }

  const written = writeCaFile(pem)
  if (!written || !currentUrl?.startsWith('mysql://')) {
    return { pemWritten: Boolean(written), patched: false, url: currentUrl }
  }

  const patchedUrl = withCaCert(currentUrl)
  const patched = patchedUrl !== currentUrl
  if (patched) process.env.DATABASE_URL = patchedUrl
  return { pemWritten: true, patched, url: patchedUrl }
}
