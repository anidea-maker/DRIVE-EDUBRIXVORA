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

export const app = express()
app.set('trust proxy', true)

app.use(cors({ origin: env.FRONTEND_URL }))
app.use(express.json({ limit: '1mb' }))

/**
 * Liveness: the process answers. Deliberately does not touch the database, so a
 * platform health check does not restart the service every time MySQL blips.
 */
app.get('/health', (_req, res) => res.json({ status: 'ok' }))

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
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      'SELECT COUNT(*) AS n FROM `_prisma_migrations`',
    )
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
app.use(errorMiddleware)
