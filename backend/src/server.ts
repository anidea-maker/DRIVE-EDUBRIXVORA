import { app } from './app.js'
import { env } from './config/env.js'
import { prisma } from './config/prisma.js'

const server = app.listen(env.APP_PORT, () => {
  console.log(`Backend running on http://localhost:${env.APP_PORT} (${process.env.NODE_ENV ?? 'development'})`)
})

/**
 * Crash guards.
 *
 * Node >= 15 ends the process on an unhandled promise rejection. This app fires
 * background work (quotas, Drive syncs) from request handlers, so one rejected
 * promise used to kill the API mid-request - which the browser reports as
 * "Failed to fetch" and which looks like a network problem from the outside.
 *
 * Now a rejected background promise is logged loudly and the process keeps
 * serving; only a genuinely unusable state (uncaught exception) is fatal.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] unhandled promise rejection (server keeps running):', reason instanceof Error ? reason.stack ?? reason.message : reason)
})

process.on('uncaughtException', (error) => {
  console.error('[fatal-guard] uncaught exception:', error instanceof Error ? error.stack ?? error.message : error)
  // An uncaught exception leaves the process in an unknown state: stop taking
  // traffic, then exit so the platform restarts a clean instance.
  shutdown('uncaughtException', 1)
})

/**
 * Graceful shutdown: stop accepting connections and close the database pool so a
 * restart does not leave half-open requests or exhausted connections behind.
 */
let shuttingDown = false
function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${reason} - closing server`)

  const forceExit = setTimeout(() => {
    console.error('[shutdown] took too long, exiting')
    process.exit(exitCode || 1)
  }, 10_000)
  forceExit.unref()

  server.close(() => {
    prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(() => {
        console.log('[shutdown] done')
        process.exit(exitCode)
      })
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
