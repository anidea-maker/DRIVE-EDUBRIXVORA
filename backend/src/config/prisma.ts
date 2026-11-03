import { PrismaClient } from '@prisma/client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'
import { loadEnvFiles } from './load-env.js'
import { resolveDatabaseConfig, maskDatabaseUrl } from './database-url.js'

// Scripts (seeds, smoke tests) import this module directly, so make sure
// `backend/.env` is loaded before the client resolves DATABASE_URL.
loadEnvFiles()

/**
 * Prisma Client talks to Turso/libSQL through a driver adapter.
 *
 * The client is generated with `engineType = "client"`: the query compiler is a
 * WebAssembly module shipped inside @prisma/client, so no native query engine is
 * downloaded, and the actual I/O is done by @libsql/client. That combination is
 * the supported way to reach Turso from Prisma 6.
 */
const database = resolveDatabaseConfig()

console.log(`[db] Using ${database.kind} database ${maskDatabaseUrl(database.url)}`)

const adapter = new PrismaLibSQL({
  url: database.url,
  ...(database.authToken ? { authToken: database.authToken } : {}),
})

export const prisma = new PrismaClient({ adapter })

/** Set once the first connection has been checked, so pings do not repeat cost. */
let foreignKeysChecked = false

/**
 * Asserts that referential actions are actually enforced.
 *
 * The schema relies on the database for `onDelete: Cascade` and `SetNull` (see
 * prisma/schema.prisma). SQLite's default is `PRAGMA foreign_keys = OFF`; the
 * libSQL client and Turso Cloud turn it on, but a different server - a
 * self-hosted sqld, a future Turso change, or a plain SQLite file opened by
 * another driver - is allowed to leave it off. In that state a user delete would
 * silently leave sessions, files and sharing tokens behind, so it is checked once
 * at boot and reported as an error rather than failing silently at runtime.
 */
export async function assertForeignKeysEnabled(): Promise<boolean> {
  if (foreignKeysChecked) return true
  foreignKeysChecked = true
  try {
    const rows = (await prisma.$queryRawUnsafe('PRAGMA foreign_keys')) as Array<{ foreign_keys: number | bigint }>
    const enabled = Number(rows[0]?.foreign_keys ?? 0) === 1
    if (!enabled) {
      console.error(
        '[db] PRAGMA foreign_keys is OFF on this connection. Deletes that rely on\n' +
          '     cascade (user -> sessions/files/shares) will leave orphan rows.\n' +
          '     Turso and libSQL enable it by default; check the database server.',
      )
    }
    return enabled
  } catch (error) {
    console.warn('[db] Could not read PRAGMA foreign_keys:', error instanceof Error ? error.message : error)
    return false
  }
}
