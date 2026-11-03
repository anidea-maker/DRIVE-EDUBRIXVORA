import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
 *   npx prisma migrate deploy   -> applies backend/prisma/migrations to Turso
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
 *   - This file is plain `.ts` on purpose (no `prisma/schema.prisma` edit needed),
 *     but it imports the compiled helpers from `dist/`, so it also works in the
 *     Docker image, which ships `dist/` instead of `src/`.
 */

const backendDir = __dirname
const compiled = path.join(backendDir, 'dist', 'config')
const source = path.join(backendDir, 'src', 'config')

if (!fs.existsSync(path.join(compiled, 'database-url.js'))) {
  throw new Error(
    'dist/config/database-url.js is missing. Run `npm run build` before using the Prisma CLI ' +
      '(the Docker image does this automatically).',
  )
}

type DatabaseConfig = {
  url: string
  authToken?: string
  kind: 'remote' | 'file' | 'memory'
}

const loadEnvFiles: () => void = (await import(pathToFileURL(path.join(compiled, 'load-env.js')).href)).loadEnvFiles
const resolveDatabaseConfig: (source?: NodeJS.ProcessEnv) => DatabaseConfig = (
  await import(pathToFileURL(path.join(compiled, 'database-url.js')).href)
).resolveDatabaseConfig

loadEnvFiles()

let database: DatabaseConfig
try {
  database = resolveDatabaseConfig()
} catch (error) {
  console.error(['', (error as Error).message, ''].join('\n'))
  throw error
}

// `prisma validate` and `prisma generate` only need the variable to exist.
process.env.DATABASE_URL ??= database.url

// Kept for the diagnostic in scripts/prisma-run.mjs and for anyone debugging.
export const databaseTarget = { ...database, sourceDir: source }

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
      url: database.url,
      ...(database.authToken ? { authToken: database.authToken } : {}),
    }),
})
