import cors from 'cors'
import express from 'express'
import { BUILD_COMMIT, BUILD_ENVIRONMENT, FEATURES } from './config/build.js'
import { frontendDir, spaEnabled, spaIndex, spaWarning } from './config/spa.js'
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
import { adminRouter } from './modules/admin/admin.routes.js'
import { frontendUrl } from './utils/redirect.js'
import { describeConfigProblem, looksLikePlaceholder } from './modules/google/config-health.js'
import { decryptText } from './utils/crypto.js'
import { resolveGoogleRedirectUri } from './modules/google/redirect-uri.js'
import { describeStorageEnvironment, listStoragePresets } from './modules/s3/presets.js'

export const app = express()
app.set('trust proxy', true)

if (spaWarning) console.warn(spaWarning)


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

/**
 * The storage API exists to be called from *another* website, so it cannot be
 * restricted to FRONTEND_URL. That is safe because it authenticates with an
 * `Authorization: Bearer` key, never with a cookie: a browser never attaches an
 * API key on its own, so allowing any origin grants nothing an attacker did not
 * already need the key for. Cookie-authenticated dashboard routes keep the
 * strict single-origin rule below.
 */
function isExternalApiPath(path: string) {
  return (
    path === '/api/v1' ||
    path.startsWith('/api/v1/') ||
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path === '/api/public' ||
    path.startsWith('/api/public/') ||
    path === '/public' ||
    path.startsWith('/public/')
  )
}

const externalApiCors = {
  origin: true,
  credentials: false,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Range/If-Range are sent by <video>/<audio> when they stream a share link.
  allowedHeaders: ['Authorization', 'Content-Type', 'Range', 'If-Range', 'X-Requested-With', 'X-File-Name', 'X-File-Type'],
  // Headers a browser client cannot read unless they are listed here; without
  // them a download looks empty and a rate limit looks like a mystery 429.
  exposedHeaders: [
    'Content-Disposition',
    'Content-Length',
    'Content-Range',
    'Accept-Ranges',
    'ETag',
    'Location',
    'X-Api-Scopes',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'Retry-After',
  ],
  maxAge: 86_400,
}

const dashboardCors = {
  origin(origin: string | undefined, callback: (error: null, allow: boolean) => void) {
    if (!origin) return callback(null, true)
    if (origin === env.FRONTEND_URL) return callback(null, true)
    if (allowAnyLocalOrigin && localOriginPattern.test(origin)) return callback(null, true)
    // Refuse without throwing: a 500 here hides the actual misconfiguration.
    return callback(null, false)
  },
  credentials: true,
}

app.use(cors((req, callback) => callback(null, isExternalApiPath(req.path) ? externalApiCors : dashboardCors)))
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
  // Compiled into the bundle, so this proves which code is running even when the
  // platform's commit variable is stale.
  features: FEATURES,
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
 * A client ID is not secret, but it is long and easy to confuse: report only
 * whether it looks like one, and a masked preview so a typo is visible.
 */
function clientIdShape(encrypted: string): string {
  try {
    const value = decryptText(encrypted)
    if (looksLikePlaceholder(value)) return `placeholder: ${value.slice(0, 40)}`
    const head = value.slice(0, 24)
    return `${head}...${value.slice(-28)}`
  } catch {
    return 'undecryptable'
  }
}

/**
 * One request that answers "is this deployment wired correctly?".
 *
 * Added after a production Google connect failed with a blank HTTP 500 on both
 * OAuth callbacks: the redirect target was built from `FRONTEND_URL`, and nothing
 * exposed the value actually in use. Public on purpose and free of secrets - it
 * names the build, the redirect mode, the database and the Google redirect URI.
 */
app.get(['/api/diagnostics', '/diagnostics'], async (req, res) => {
  const requestOrigin = `${req.protocol}://${req.get('host')}`
  const expectedRedirectUri = `${requestOrigin}/connected-accounts/google/callback`
  const hints: string[] = []

  let database: Record<string, unknown>
  try {
    await prisma.$queryRawUnsafe('SELECT 1')
    const rows = (await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM `_prisma_migrations`',
    )) as Array<{ n: bigint | number }>
    database = { ok: true, migrations: String(rows[0]?.n ?? 0) }
  } catch (error) {
    database = { ok: false, message: error instanceof Error ? error.message : String(error) }
    hints.push('The database is unreachable: check DATABASE_URL and DATABASE_CA_CERT, then redeploy.')
  }

  let google: Record<string, unknown>
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    if (!config) {
      google = { configured: false, expectedRedirectUri }
      hints.push('Google OAuth is not configured: save the Client ID and Secret in Settings -> Google OAuth Credentials.')
    } else {
      // Report the client ID's *shape* only. A placeholder here is what broke the
      // live deployment: Google refused `client_id=<client id>` before consent.
      const redirectUri = resolveGoogleRedirectUri(req, config.redirectUri)
      const problem = describeConfigProblem({ ...config, redirectUri })
      google = {
        configured: problem === null,
        problem,
        redirectUri,
        storedRedirectUri: config.redirectUri,
        expectedRedirectUri,
        redirectUriMatchesThisHost: redirectUri === expectedRedirectUri,
        clientIdShape: clientIdShape(config.clientIdEncrypted),
      }
      if (problem) {
        hints.push(`${problem} Save the Client ID and Secret again in Settings -> Google OAuth Credentials (the Redirect URI can stay empty).`)
      }
      if (redirectUri !== expectedRedirectUri) {
        hints.push(`This Deployment will ask Google to return to ${redirectUri}. Add that exact URL to Google Cloud -> Credentials -> Authorized redirect URIs, or visit the site on ${expectedRedirectUri.split('/connected-accounts')[0]}.`)
      }
    }
  } catch (error) {
    google = { error: error instanceof Error ? error.message : String(error) }
  }

  /**
   * Is anything actually connected? Counts only - no addresses or names, so this
   * stays safe on a public endpoint while answering "did my connect attempt work?".
   */
  let accountsSummary: Record<string, unknown>
  try {
    // Plain `count` calls rather than `groupBy`: the generated client's groupBy
    // input type is strict enough that a single-field `_count` object failed to
    // assign on the deploy host (TS2345), and the count of connected storage is
    // all this endpoint needs.
    const [googleDrive, s3, googleDriveAll, s3All] = await Promise.all([
      prisma.connectedAccount.count({ where: { provider: 'google_drive', status: 'connected' } }),
      prisma.connectedAccount.count({ where: { provider: 's3', status: 'connected' } }),
      prisma.connectedAccount.count({ where: { provider: 'google_drive' } }),
      prisma.connectedAccount.count({ where: { provider: 's3' } }),
    ])
    accountsSummary = {
      googleDrive,
      s3,
      byProvider: {
        'google_drive:connected': googleDrive,
        's3:connected': s3,
        'google_drive:total': googleDriveAll,
        's3:total': s3All,
      },
    }
    if (googleDrive === 0) hints.push('No Google Drive account is connected yet: open Settings -> Connect Drive and approve access.')
    if (s3 === 0) hints.push('No S3 bucket is connected yet: open Settings -> Connect S3.')
  } catch (error) {
    accountsSummary = { error: error instanceof Error ? error.message : String(error) }
  }

  const hasControlChars = /[\u0000-\u001f\u007f]/.test(env.FRONTEND_URL)
  if (hasControlChars) {
    hints.push('FRONTEND_URL contains control characters (usually a pasted newline). Remove them - the value is wrong even though redirects stay safe.')
  }
  for (const preset of listStoragePresets()) {
    if (preset.ready) continue
    if (preset.emptyVars.length > 0) {
      hints.push(
        `${preset.label}: ${preset.emptyVars.join(', ')} ${preset.emptyVars.length === 1 ? 'is' : 'are'} present on the service but ` +
          'empty (or still a placeholder), so they are ignored. Paste the real value next to each key in your host dashboard, then redeploy. ' +
          'Until then, Connect S3 -> Enter manually works.',
      )
    } else if (preset.unsetVars.length < 6 && preset.unsetVars.length > 0) {
      hints.push(`${preset.label}: set ${preset.unsetVars.join(', ')} on the service to enable one-click connect, or use Connect S3 -> Enter manually.`)
    }
  }
  if (spaEnabled) {
    hints.push('Single-service mode: OAuth callbacks redirect with a relative path, so FRONTEND_URL cannot send the browser to the wrong host.')
  } else if (env.FRONTEND_URL_SOURCE === 'default' && BUILD_ENVIRONMENT === 'production') {
    hints.push(`FRONTEND_URL fell back to localhost in production - set it to this site's origin, or deploy with the root Dockerfile so the SPA is served here.`)
  }

  return res.json({
    commit: BUILD_COMMIT,
    environment: BUILD_ENVIRONMENT,
    uptimeSeconds: Math.round(process.uptime()),
    features: FEATURES,
    requestOrigin,
    frontend: {
      mode: spaEnabled ? 'single-service' : 'split',
      url: env.FRONTEND_URL,
      source: env.FRONTEND_URL_SOURCE,
      headerSafe: !hasControlChars,
      // Exactly where a failed connect attempt sends the browser.
      oauthRedirectPreview: frontendUrl('/google-connected', { status: 'error', reason: 'STATE_EXPIRED' }),
    },
    spa: { enabled: spaEnabled, directory: frontendDir || null },
    database,
    google,
    storage: describeStorageEnvironment(),
    accounts: accountsSummary,
    hints,
  })
})

/**
 * Self-test of the two OAuth callbacks, run inside the deployed process.
 *
 * It calls this app over loopback with a deliberately invalid code/state, so it
 * exercises the real route, the real error handler and the real redirect - without
 * Google, without a browser and without needing the Render log. Whatever the
 * callbacks do in production appears here verbatim.
 */
app.get(['/api/diagnostics/oauth', '/diagnostics/oauth'], async (_req, res) => {
  const port = process.env.PORT ?? String(env.APP_PORT)
  const probe = async (path: string) => {
    const url = `http://127.0.0.1:${port}${path}`
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const body = (await response.text()).slice(0, 300)
      return { path, status: response.status, location: response.headers.get('location'), body }
    } catch (error) {
      return { path, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const [connect, signIn] = await Promise.all([
    probe('/api/connected-accounts/google/callback?code=self-test&state=self-test'),
    probe('/api/auth/google/callback?code=self-test&state=self-test'),
  ])

  const ok = (result: { status?: number; location?: string | null }) =>
    result.status === 302 && Boolean(result.location && result.location.includes('reason='))

  return res.json({
    commit: BUILD_COMMIT,
    verdict: ok(connect) && ok(signIn) ? 'callbacks redirect with a reason' : 'a callback did not redirect - see results',
    connect,
    signIn,
    expectation: {
      status: 302,
      location: '/google-connected?status=error&reason=STATE_EXPIRED (or an absolute URL with the same path)',
    },
  })
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
  ['/admin', adminRouter],
]

for (const [prefix, router] of API_ROUTERS) {
  app.use(prefix, router)
  app.use(`/api${prefix}`, router)
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
