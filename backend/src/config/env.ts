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

export const env = parsed.data
