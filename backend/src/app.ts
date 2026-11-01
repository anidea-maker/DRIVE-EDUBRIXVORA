import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
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

/**
 * CORS: only the configured frontend origin is allowed in production.
 *
 * In development any localhost/127.0.0.1 port is accepted, because the Vite dev
 * server port can differ from FRONTEND_URL (and `localhost` vs `127.0.0.1` are
 * different origins to the browser). Rejecting them shows up in the browser as a
 * bare "Failed to fetch", which says nothing about the real cause.
 *
 * A missing Origin header (curl, same-origin, server-to-server) is always fine.
 */
const allowAnyLocalOrigin = process.env.NODE_ENV !== 'production'
const localOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true)
      if (origin === env.FRONTEND_URL) return callback(null, true)
      if (allowAnyLocalOrigin && localOriginPattern.test(origin)) return callback(null, true)
      // Refuse without throwing: a 500 here hides the actual misconfiguration.
      return callback(null, false)
    },
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))

/**
 * Liveness: the process answers. Deliberately does not touch the database, so a
 * platform health check does not restart the service every time MySQL blips.
 *
 * `commit` makes it obvious when a deploy is serving an older build than `main`.
 */
const healthPayload = () => ({
  status: 'ok',
  commit: BUILD_COMMIT,
  environment: BUILD_ENVIRONMENT,
  uptimeSeconds: Math.round(process.uptime()),
})

app.get(['/health', '/api/health'], (_req, res) => res.json(healthPayload()))

/**
 * Readiness: can this instance actually serve requests? Runs one query, so a
 * missing/unreachable database or unapplied migrations are visible with a single
 * browser request instead of a log dig.
 */
app.get(['/ready', '/api/ready'], async (_req, res) => {
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
/**
 * Public REST API used by external clients (`/api/v1/uploads`). Mounted first so
 * the `/api` prefix below cannot shadow it.
 */
app.use('/api', publicApiRouter)

/**
 * Every router is reachable twice: bare (`/auth/register`) because nginx strips
 * the `/api` prefix in the two-service setup, and under `/api` (`/api/auth/...`)
 * because the SPA always calls `<base>/auth/...` with base `/api`. The second
 * form is what makes single-service deployments work with no proxy at all.
 */
const API_ROUTERS: Array<[string, import('express').Router]> = [
  ['/public', publicRouter],
  ['/auth', authRouter],
  ['/api-keys', apiKeyRouter],
  ['/provider-configs', providerConfigRouter],
  ['/connected-accounts', connectedAccountRouter],
  ['/storage', storageRouter],
  ['/uploads', uploadRouter],
  ['/files', fileRouter],
  ['/folders', folderRouter],
  ['/invites', inviteRouter],
  ['/audit-logs', auditLogRouter],
  ['/system', systemRouter],
]

for (const [prefix, router] of API_ROUTERS) {
  app.use(prefix, router)
  app.use(`/api${prefix}`, router)
}
/**
 * Single-service mode: serve the built SPA from this same process.
 *
 * Set `SERVE_FRONTEND` to the directory containing `index.html` (the root
 * Dockerfile uses /app/public). The browser then talks to the API on its own
 * origin, so there is no `API_UPSTREAM`, no CORS and no build-time API URL to get
 * wrong - one deployment, one URL.
 */
const frontendDir = process.env.SERVE_FRONTEND?.trim()
const spaIndex = frontendDir ? path.join(frontendDir, 'index.html') : ''
const spaEnabled = Boolean(spaIndex) && fs.existsSync(spaIndex)

if (frontendDir && !spaEnabled) {
  console.warn(`[app] SERVE_FRONTEND=${frontendDir} has no index.html - SPA hosting disabled.`)
}
if (spaEnabled) {
  console.log(`[app] Serving the SPA from ${frontendDir}`)
  // Hashed assets are immutable; the shell and service worker must not be cached.
  app.use(
    express.static(frontendDir as string, {
      index: false,
      setHeaders: (res, filePath) => {
        if (/[\\/]assets[\\/]/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else if (/[\\/](sw\.js|index\.html|manifest\.webmanifest|registerSW\.js)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'no-cache')
        }
      },
    }),
  )

  // Any non-API GET falls back to the SPA so client-side routes work on reload.
  // NOTE: express 5 removed the "*" path pattern - use plain middleware.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const isApi =
      req.path === '/api' ||
      req.path.startsWith('/api/') ||
      req.path === '/health' ||
      req.path === '/ready' ||
      req.path === '/public' ||
      req.path.startsWith('/public/')
    if (isApi) return next()
    // The shell must never be cached, or a redeploy keeps serving the old bundle.
    return res.sendFile(spaIndex, { headers: { 'Cache-Control': 'no-cache' } })
  })
}

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
