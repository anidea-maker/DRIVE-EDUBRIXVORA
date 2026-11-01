import { z } from 'zod'
import { loadEnvFiles } from './load-env.js'

loadEnvFiles()

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().default(4000),
  FRONTEND_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  MAX_UPLOAD_BYTES: z.coerce.number().default(5 * 1024 * 1024 * 1024),
  RECAPTCHA_SECRET_KEY: z.string().optional(),
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

export const env = parsed.data
