import { z } from 'zod'
import { loadEnvFiles } from './load-env.js'

loadEnvFiles()

/**
 * Best guess for this deployment's own public origin, used when FRONTEND_URL is
 * not configured: Render/Railway/Fly expose it, local dev falls back to Vite.
 */
function defaultFrontendUrl(): string {
  const platformHost =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.FLY_APP_NAME?.concat('.fly.dev') ||
    ''
  if (platformHost) return `https://${platformHost}`
  return 'http://localhost:5173'
}

/** Control characters make a `Location` header invalid (Node throws ERR_INVALID_CHAR). */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/**
 * Accepts "https://app.example.com", "app.example.com" or "app.example.com/".
 * CORS needs a precise origin, and platforms hand out bare hostnames.
 *
 * Control characters (a pasted newline, say) are removed here: `z.string().url()`
 * accepts a value with a trailing newline, and the resulting redirect then throws
 * at request time - which showed up as a blank HTTP 500 on every OAuth callback.
 */
function normalizeOrigin(value: string): string {
  const stripped = value.replace(CONTROL_CHARS, '')
  if (stripped !== value) {
    console.warn('[env] FRONTEND_URL contained control characters - they were removed. Re-check the value in your host dashboard.')
  }
  const trimmed = stripped.trim().replace(/\/+$/, '')
  if (!trimmed) return trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(trimmed)
  return `${isLocal ? 'http' : 'https'}://${trimmed}`
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // Platforms such as Render, Railway, Cloud Run and Heroku inject PORT and
  // health-check that exact port, so it takes precedence over APP_PORT.
  PORT: z.coerce.number().optional(),
  APP_PORT: z.coerce.number().default(4000),
  // A bare host (as injected by platform blueprints) is upgraded to an origin.
  // Optional: when the SPA is served by this same process there is no CORS
  // negotiation at all, so the platform's own hostname is a safe default.
  FRONTEND_URL: z
    .string()
    .optional()
    .transform((value) => normalizeOrigin(value?.trim() || defaultFrontendUrl()))
    .pipe(z.string().url()),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  /**
   * Origin to put in links that leave this service (share URLs, download URLs in
   * API responses). Only needed behind a proxy that rewrites Host; otherwise the
   * request's own origin is used, which is correct by construction.
   */
  PUBLIC_BASE_URL: z
    .string()
    .optional()
    .transform((value) => (value?.trim() ? normalizeOrigin(value) : undefined))
    .pipe(z.string().url().optional()),
  /** Request budget per API key, per minute. 0 disables the limit. */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(600),
  /**
   * Bootstrap for the super-admin role. Comma-separated, lower-cased email
   * addresses. This is server-side configuration, never a value a browser can
   * supply; it exists so a fresh deployment does not need a manual DB edit.
   */
  SUPER_ADMIN_EMAILS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .replace(CONTROL_CHARS, '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)),
    ),
  /** Lifetime of an Edvanta preview/download capability URL, in seconds. */
  RESOURCE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /** Guards against a bulk ZIP that would exhaust Render's memory or timeout. */
  RESOURCE_BULK_MAX_FILES: z.coerce.number().int().min(1).max(100).default(25),
  RESOURCE_BULK_MAX_BYTES: z.coerce.number().int().min(1024).max(5 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
  /**
   * Signs expiring object URLs (`POST /api/v1/objects/sign`). Optional: without it
   * a key is derived from TOKEN_ENCRYPTION_KEY, so signed links work on an
   * existing deployment with no new configuration.
   */
  OBJECT_URL_SIGNING_SECRET: z.string().min(16).optional(),
  /**
   * Directory holding the built SPA. Set by the single-service Dockerfile, and the
   * signal that this process is also the web server - so browser redirects can be
   * relative and do not depend on FRONTEND_URL at all.
   */
  SERVE_FRONTEND: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(env)'
    const rawValue = process.env[key]
    if (rawValue === undefined || rawValue.trim() === '') {
      return `  - ${key} is missing`
    }
    return `  - ${key} is invalid: ${issue.message}`
  })

  console.error(
    [
      '',
      'Backend environment is not configured, so the server cannot start.',
      ...problems,
      '',
      'Fix it with one of these:',
      '  cd backend && npm run env:setup      # creates backend/.env with defaults + random secrets',
      '  cp backend/.env.example backend/.env # then edit the values by hand',
      '',
      'DATABASE_URL must be a MySQL connection string, e.g.',
      '  DATABASE_URL="mysql://root@localhost:3306/9drive"',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

/**
 * Placeholder passwords copied from a provider dashboard fail every query with a
 * cryptic "Access denied for user", so catch them at boot instead.
 */
const DATABASE_URL_PLACEHOLDERS = [
  'CLICK_TO_REVEAL_PASSWORD',
  'REPLACE_WITH',
  'change-this-database-password',
]

const placeholder = DATABASE_URL_PLACEHOLDERS.find((token) => parsed.data.DATABASE_URL.includes(token))

if (placeholder) {
  console.error(
    [
      '',
      `DATABASE_URL still contains the placeholder "${placeholder}".`,
      'Paste the real database password into backend/.env, then start the server again.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const databaseParams = new URL(parsed.data.DATABASE_URL).searchParams

if (databaseParams.has('ssl-mode') || databaseParams.has('sslmode')) {
  console.warn(
    '[env] DATABASE_URL uses "ssl-mode"/"sslmode", which Prisma MySQL ignores - the ' +
      'connection will not be encrypted. Use sslaccept=accept_invalid_certs, or ' +
      'sslcert=certs/aiven-ca.pem&sslaccept=strict for verified TLS.',
  )
}

/**
 * Where FRONTEND_URL came from. `configured` means an operator set it, `platform`
 * means it was derived from the host's own public hostname, `default` means local
 * development with nothing set.
 */
const FRONTEND_URL_SOURCE: 'configured' | 'platform' | 'default' = process.env.FRONTEND_URL?.trim()
  ? 'configured'
  : defaultFrontendUrl().includes('localhost')
    ? 'default'
    : 'platform'

/** A localhost/private origin cannot be reached by a browser on the public site. */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i

const FRONTEND_URL_USABLE =
  FRONTEND_URL_SOURCE !== 'default' && !(process.env.NODE_ENV === 'production' && LOCAL_ORIGIN.test(parsed.data.FRONTEND_URL))

if (process.env.NODE_ENV === 'production' && LOCAL_ORIGIN.test(parsed.data.FRONTEND_URL)) {
  console.warn(
    `[env] FRONTEND_URL is ${parsed.data.FRONTEND_URL} while NODE_ENV=production. A browser on the live site cannot ` +
      'reach that origin, so it is ignored: redirects stay on the host that served the request. Set FRONTEND_URL to ' +
      "this service's own URL (or remove it) to silence this warning.",
  )
}

export const env = {
  ...parsed.data,
  APP_PORT: parsed.data.PORT ?? parsed.data.APP_PORT,
  FRONTEND_URL_SOURCE,
  FRONTEND_URL_USABLE,
}
