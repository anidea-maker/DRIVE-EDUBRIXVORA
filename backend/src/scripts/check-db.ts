/**
 * `npm run db:check` - verifies the database configuration end to end.
 *
 * Prints the resolved target (token masked), opens a real libSQL connection with
 * the same adapter the API uses, and runs the queries that matter for Turso:
 * a `SELECT 1`, the SQLite version, the migration count, whether foreign keys are
 * enforced on this connection, and whether every expected table exists.
 *
 * It also explains the mistakes that actually happen when moving from MySQL/Aiven
 * to Turso: a leftover `mysql://` URL, a missing auth token, or a schema that was
 * never migrated.
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadEnvFiles } from '../config/load-env.js'
import {
  DEFAULT_LOCAL_DATABASE,
  localDatabaseFile,
  maskDatabaseUrl,
  resolveDatabaseConfig,
} from '../config/database-url.js'

loadEnvFiles()

const PLACEHOLDERS = ['REPLACE_WITH', 'your-token', 'CLICK_TO_REVEAL', 'change-this']

const EXPECTED_TABLES = [
  'users',
  'user_sessions',
  'auth_handoffs',
  'provider_configs',
  'oauth_states',
  'connected_accounts',
  's3_storage_configs',
  'storage_accounts',
  'files',
  'file_shares',
  'file_preview_tokens',
  'folders',
  'upload_sessions',
  'audit_logs',
  'workspace_invites',
  'api_keys',
  'api_key_rate_limit_windows',
  'upload_routing_policies',
]

function stop(lines: string[]): never {
  console.error(['', ...lines, ''].join('\n'))
  process.exit(1)
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.TURSO_DATABASE_URL) {
    console.log(`DATABASE_URL        not set - falling back to the local file ${DEFAULT_LOCAL_DATABASE.url}`)
  }

  let config: ReturnType<typeof resolveDatabaseConfig>
  try {
    config = resolveDatabaseConfig()
  } catch (error) {
    stop([
      'The database configuration is not usable.',
      '',
      error instanceof Error ? error.message : String(error),
    ])
  }

  const placeholder = PLACEHOLDERS.find((token) =>
    `${config.url} ${config.authToken ?? ''}`.includes(token),
  )
  if (placeholder) {
    stop([
      `The database configuration still contains the placeholder "${placeholder}".`,
      'Paste the real Turso URL and token into backend/.env, then run this again.',
    ])
  }

  console.log(`Target              ${config.kind} ${maskDatabaseUrl(config.url)}`)
  console.log(`Auth token          ${config.authToken ? `set (${config.authToken.length} chars, not printed)` : 'not needed / not set'}`)

  const localFile = localDatabaseFile(config.url)
  if (localFile) {
    console.log(`SQLite file         ${localFile} (${fs.existsSync(localFile) ? 'exists' : 'will be created by the first migration'})`)
  }

  let prisma: typeof import('../config/prisma.js').prisma
  try {
    ;({ prisma } = await import('../config/prisma.js'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stop([
      'Prisma Client could not be created, so the connection check cannot run.',
      '',
      message.split('\n')[0],
      '',
      'Run `npm run prisma:generate`, then `npm run db:check` again.',
    ])
  }

  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    const version = (await prisma.$queryRawUnsafe('SELECT sqlite_version() AS version')) as Array<{ version: string }>
    console.log(`Connected           SQLite ${version[0]?.version ?? '?'}`)

    // Referential actions are enforced by the database, so this must be ON.
    const pragma = (await prisma.$queryRawUnsafe('PRAGMA foreign_keys')) as Array<{ foreign_keys: number | bigint }>
    const foreignKeysOn = Number(pragma[0]?.foreign_keys ?? 0) === 1
    console.log(`Foreign keys        ${foreignKeysOn ? 'ON (cascades active)' : 'OFF - onDelete: Cascade will NOT fire'}`)
    if (!foreignKeysOn && config.kind !== 'file') {
      console.warn(
        '                    This server does not enable foreign keys. Deletes that rely on\n' +
          '                    cascade (user -> sessions/files) will leave orphan rows.',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hints: string[] = []
    if (/401|unauthorized|invalid token|JWT/i.test(message)) {
      hints.push(
        'Turso rejected the auth token.',
        '  - create a fresh one: turso db tokens create <database>',
        '  - paste it as TURSO_AUTH_TOKEN (no quotes in the dashboard)',
      )
    }
    if (/ENOTFOUND|EAI_AGAIN|fetch failed|getaddrinfo/i.test(message)) {
      hints.push(
        'The host could not be reached.',
        '  - copy the URL from `turso db show <database> --url`',
        '  - it looks like libsql://<database>-<org>.turso.io',
      )
    }
    if (/URL_SCHEME|unsupported|protocol/i.test(message)) {
      hints.push('Only libsql://, https://, turso:// and file: URLs are supported (no mysql://).')
    }
    stop([
      'The database query failed.',
      '',
      message,
      ...(hints.length ? ['', 'Hints:', ...hints.map((hint) => `  ${hint}`)] : []),
    ])
  }

  try {
    const rows = (await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM "_prisma_migrations"',
    )) as Array<{ n: bigint | number }>
    console.log(`Migrations          ${rows[0]?.n ?? 0} applied - see npm run db:status`)
  } catch {
    console.log('Migrations          none applied yet - run `npm run db:migrate:deploy`')
  }

  try {
    const rows = (await prisma.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )) as Array<{ name: string }>
    const present = new Set(rows.map((row) => row.name))
    const missing = EXPECTED_TABLES.filter((table) => !present.has(table))
    console.log(`Tables              ${EXPECTED_TABLES.length - missing.length}/${EXPECTED_TABLES.length} expected tables present`)
    if (missing.length) {
      console.log(`                    missing: ${missing.join(', ')}`)
      console.log('                    apply the schema with `npm run db:migrate:deploy`')
    }
  } catch (error) {
    console.log(`Tables              could not be listed: ${error instanceof Error ? error.message : String(error)}`)
  }

  await prisma.$disconnect()

  const migrationsDir = path.resolve(__dirname, '..', '..', 'prisma', 'migrations')
  if (fs.existsSync(migrationsDir)) {
    const pending = fs
      .readdirSync(migrationsDir)
      .filter((entry) => fs.statSync(path.join(migrationsDir, entry)).isDirectory())
    console.log(`Migration files     ${pending.length} in prisma/migrations`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
