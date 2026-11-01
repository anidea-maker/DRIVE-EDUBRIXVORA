import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorMiddleware } from './middleware/error.middleware.js'
import { prisma } from './config/prisma.js'
import { authRouter } from './modules/auth/auth.routes.js'
import { providerConfigRouter } from './modules/provider-configs/provider-config.routes.js'
import { connectedAccountRouter } from './modules/connected-accounts/connected-account.routes.js'
import { storageRouter } from './modules/storage/storage.routes.js'
import { uploadRouter } from './modules/uploads/upload.routes.js'
import { fileRouter } from './modules/files/file.routes.js'
import { folderRouter } from './modules/folders/folder.routes.js'
import { publicRouter } from './modules/public/public.routes.js'
import { inviteRouter } from './modules/invites/invite.routes.js'
import { apiKeyRouter } from './modules/api-keys/api-key.routes.js'
import { publicApiRouter } from './modules/public-api/public-api.routes.js'
import { auditLogRouter } from './modules/audit-logs/audit-log.routes.js'
import { systemRouter } from './modules/system/system.routes.js'

/**
 * Which build is actually running. Render/GitHub/Railway/Fly all expose the
 * deployed revision under one of these names; "unknown" means nobody set it.
 */
const BUILD_COMMIT =
  process.env.RENDER_GIT_COMMIT?.slice(0, 7) ||
  process.env.GIT_COMMIT?.slice(0, 7) ||
  process.env.SOURCE_VERSION?.slice(0, 7) ||
  process.env.COMMIT_SHA?.slice(0, 7) ||
  'unknown'

const BUILD_ENVIRONMENT = process.env.NODE_ENV ?? 'development'

export const app = express()
app.set('trust proxy', true)

app.use(cors({ origin: env.FRONTEND_URL }))
app.use(express.json({ limit: '1mb' }))

/**
 * Liveness: the process answers. Deliberately does not touch the database, so a
 * platform health check does not restart the service every time MySQL blips.
 *
 * `commit` makes it obvious when a deploy is serving an older build than `main`.
 */
app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    commit: BUILD_COMMIT,
    environment: BUILD_ENVIRONMENT,
    uptimeSeconds: Math.round(process.uptime()),
  }),
)

/**
 * Readiness: can this instance actually serve requests? Runs one query, so a
 * missing/unreachable database or unapplied migrations are visible with a single
 * browser request instead of a log dig.
 */
app.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return res.status(503).json({
      status: 'error',
      database: 'unreachable',
      message,
      hint: 'Check DATABASE_URL and DATABASE_CA_CERT on the backend service, then redeploy. `npm run db:check` gives a full report.',
    })
  }

  try {
    // Cast instead of a type argument so this compiles even before
    // `prisma generate` has produced the typed client.
    const rows = (await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM `_prisma_migrations`',
    )) as Array<{ n: bigint | number }>
    return res.json({ status: 'ok', database: 'ok', migrations: String(rows[0]?.n ?? 0) })
  } catch {
    return res.status(503).json({
      status: 'error',
      database: 'ok',
      migrations: 'missing',
      hint: 'The database is reachable but has no schema. Run `npm run db:migrate:deploy` (the container does this on boot).',
    })
  }
})
app.use('/api', publicApiRouter)
app.use('/public', publicRouter)
app.use('/auth', authRouter)
app.use('/api-keys', apiKeyRouter)
app.use('/provider-configs', providerConfigRouter)
app.use('/connected-accounts', connectedAccountRouter)
app.use('/storage', storageRouter)
app.use('/uploads', uploadRouter)
app.use('/files', fileRouter)
app.use('/folders', folderRouter)
app.use('/invites', inviteRouter)
app.use('/audit-logs', auditLogRouter)
app.use('/system', systemRouter)
/**
 * Unknown route. Express's default answer is an HTML "Cannot GET /ready", which
 * looks like an outage even when the real cause is an older deployed build.
 */
app.use((req, res) => {
  const knownEndpoint = req.path === '/ready' || req.path === '/health'
  return res.status(404).json({
    code: 'NOT_FOUND',
    message: `No route for ${req.method} ${req.path}`,
    commit: BUILD_COMMIT,
    ...(knownEndpoint
      ? {
          hint: `This path exists in newer builds. The backend is running commit ${BUILD_COMMIT}, which predates it - redeploy the backend from main.`,
        }
      : {}),
  })
})

app.use(errorMiddleware)
