import { Router } from 'express'
import { exec, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'
import { describeConfigProblem, looksLikePlaceholder, GOOGLE_CALLBACK_PATH } from '../google/config-health.js'
import { repairStoredRedirectUri, requestOrigin, resolveGoogleRedirectUri } from '../google/redirect-uri.js'
import Busboy from 'busboy'

export const systemRouter = Router()


systemRouter.post('/update', requireAuth, (req, res, next) => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const updateScript = path.join(projectRoot, 'update.sh')

  // Check if git is installed
  exec('git --version', (gitError) => {
    if (gitError) {
      return res.status(400).json({
        code: 'GIT_NOT_FOUND',
        message: 'Git is not installed inside the app container. Since you are running 9Drive in Docker, please update by running:\n\n1. ssh root@103.65.237.136\n2. cd 9drive\n3. git pull\n4. docker-compose down && docker-compose up -d --build\n\ndirectly in your VPS host terminal.'
      })
    }

    if (fs.existsSync(updateScript)) {
      try {
        // Clear old update log to prevent race conditions on frontend polling
        const logFile = path.join(projectRoot, 'update.log')
        fs.writeFileSync(logFile, 'Initiating update...\n')

        const child = spawn('bash', ['update.sh'], {
          cwd: projectRoot,
          detached: true,
          stdio: 'ignore'
        })
        child.unref()

        return res.json({
          status: 'success',
          message: 'System update initiated. Rebuilding and restarting backend & frontend in the background. Please wait ~1 minute and refresh the page.'
        })
      } catch (err: any) {
        return res.status(500).json({
          code: 'UPDATE_FAILED',
          message: 'Failed to start update script.',
          error: err.message
        })
      }
    } else {
      // Fallback to simple git pull if update.sh doesn't exist
      exec('git pull', { cwd: projectRoot }, (error, stdout, stderr) => {
        if (error) {
          console.error('System update failed:', error)
          return res.status(500).json({
            code: 'UPDATE_FAILED',
            message: 'Failed to run git pull. Make sure git is installed and configured.',
            error: error.message,
            stderr
          })
        }

        console.log('System update stdout:', stdout)
        if (stderr) {
          console.warn('System update stderr:', stderr)
        }

        return res.json({
          status: 'success',
          message: 'System code updated successfully. Dev servers will auto-restart.',
          stdout,
          stderr
        })
      })
    }
  })
})

systemRouter.get('/update-log', requireAuth, (req, res) => {
  const projectRoot = path.resolve(process.cwd(), '..')
  const logFile = path.join(projectRoot, 'update.log')

  if (!fs.existsSync(logFile)) {
    return res.json({
      log: 'No update history found.'
    })
  }

  try {
    const logContent = fs.readFileSync(logFile, 'utf8')
    return res.json({
      log: logContent
    })
  } catch (error: any) {
    return res.status(500).json({
      code: 'READ_LOG_FAILED',
      message: 'Failed to read update log file.',
      error: error.message
    })
  }
})

systemRouter.get('/google-config', requireAuth, async (req, res, next) => {
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    // The Settings form must show the URL Google will actually be given, not a
    // stored placeholder: pre-filling `https://<new-service>.onrender.com/...` made
    // re-saving the form keep the broken value.
    const defaultRedirect = resolveGoogleRedirectUri(req, null)

    if (!config) {
      return res.json({
        exists: false,
        defaultRedirectUri: defaultRedirect
      })
    }

    let clientId = ''
    try {
      clientId = decryptText(config.clientIdEncrypted)
    } catch {
      clientId = ''
    }

    const redirectUri = resolveGoogleRedirectUri(req, config.redirectUri)
    void repairStoredRedirectUri(config.id, config.redirectUri, redirectUri)

    return res.json({
      exists: true,
      clientId,
      redirectUri,
      storedRedirectUri: config.redirectUri,
      problem: describeConfigProblem({ ...config, redirectUri }),
      hasSecret: !!config.clientSecretEncrypted,
      defaultRedirectUri: defaultRedirect
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Reads the body sent by Settings -> Google OAuth Credentials and validates it
 * before anything is written.
 *
 * Every rejection names the field and the fix: a paste that includes a label, a
 * trailing space copied from the Google console, or a redirect URI for the wrong
 * host are the usual reasons a save "just doesn't work".
 */
// Deliberately loose: any OAuth *web* client ID ends in this suffix. Only reject
// values that clearly are not one (a project number, an API key, a URL).
const googleClientIdPattern = /^[^\s]+\.apps\.googleusercontent\.com$/i

/** Placeholder detection, ignoring surrounding whitespace so `<client secret>` matches. */
function rawSecretLooksLikePlaceholder(secret: string): boolean {
  return looksLikePlaceholder(secret)
}

function readGoogleBody(body: unknown, request: { protocol: string; host: string }) {
  const input = (body ?? {}) as { clientId?: unknown; clientSecret?: unknown; redirectUri?: unknown }

  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : ''
  const clientSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : ''
  const rawRedirect = typeof input.redirectUri === 'string' ? input.redirectUri.trim() : ''

  if (!clientId) {
    return { error: { code: 'BAD_REQUEST', message: 'Client ID is required. Copy it from Google Cloud -> APIs & Services -> Credentials.' } } as const
  }
  if (looksLikePlaceholder(clientId)) {
    return {
      error: {
        code: 'BAD_REQUEST',
        message: 'That Client ID is documentation text, not a real value. Copy the ID ending in ".apps.googleusercontent.com" from Google Cloud -> APIs & Services -> Credentials.',
      },
    } as const
  }
  if (/\s/.test(clientId)) {
    return { error: { code: 'BAD_REQUEST', message: 'Client ID contains a space or line break. Copy just the ID, with no surrounding whitespace.' } } as const
  }
  if (/^https?:\/\//i.test(clientId) || clientId.includes('console.cloud.google.com')) {
    return { error: { code: 'BAD_REQUEST', message: 'That looks like a URL, not a Client ID. Use the value ending in ".apps.googleusercontent.com".' } } as const
  }
  if (!googleClientIdPattern.test(clientId)) {
    return {
      error: {
        code: 'BAD_REQUEST',
        message: 'Client ID should look like "123456789012-abcdef.apps.googleusercontent.com". Check that you copied the OAuth client ID (not the project number or the API key).',
      },
    } as const
  }
  // An empty secret is "not provided" (the stored one may be reused) - only a
  // non-empty placeholder is an error.
  if (clientSecret && rawSecretLooksLikePlaceholder(clientSecret)) {
    return {
      error: {
        code: 'BAD_REQUEST',
        message: 'That Client Secret is documentation text, not a real value. Copy it from Google Cloud -> APIs & Services -> Credentials -> your OAuth 2.0 Client IDs -> "Client secret".',
      },
    } as const
  }
  if (/\s/.test(clientSecret)) {
    return { error: { code: 'BAD_REQUEST', message: 'Client Secret contains a space or line break. Copy it again without surrounding whitespace.' } } as const
  }

  // The default has to be reachable over https: Google rejects http redirect URIs
  // for anything except localhost, and behind a proxy req.protocol can be http.
  const origin = requestOrigin({
    protocol: request.protocol,
    get: (name: string) => (name === 'host' ? request.host : undefined),
  })
  const defaultRedirect = `${origin ?? `https://${request.host || 'localhost:4000'}`}${GOOGLE_CALLBACK_PATH}`

  let redirectUri = defaultRedirect
  if (rawRedirect) {
    let parsed: URL
    try {
      parsed = new URL(rawRedirect)
    } catch {
      return { error: { code: 'BAD_REQUEST', message: `Redirect URI "${rawRedirect}" is not a full URL. Use ${defaultRedirect}.` } } as const
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { error: { code: 'BAD_REQUEST', message: 'Redirect URI must start with https:// (or http:// for localhost).' } } as const
    }
    if (parsed.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(parsed.host)) {
      return {
        error: {
          code: 'BAD_REQUEST',
          message: `Google rejects http:// redirect URIs. Use https://${parsed.host}${parsed.pathname}.`,
        },
      } as const
    }
    if (!parsed.pathname.endsWith('/connected-accounts/google/callback')) {
      return {
        error: {
          code: 'BAD_REQUEST',
          message: `Redirect URI must end with /connected-accounts/google/callback (got ${parsed.pathname}). Use ${defaultRedirect} unless you changed the route on purpose.`,
        },
      } as const
    }
    redirectUri = parsed.toString()
  }

  return { clientId, clientSecret, redirectUri, defaultRedirect } as const
}

systemRouter.post('/google-config', requireAuth, async (req, res, next) => {
  try {
    const parsed = readGoogleBody(req.body, { protocol: req.protocol, host: req.get('host') ?? '' })
    if ('error' in parsed) return res.status(400).json(parsed.error)

    const { clientId, clientSecret, redirectUri } = parsed

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]

    // A placeholder is not a credential. Saving one "succeeds" and leaves Connect
    // Drive broken with a green message, which is how `<client secret>` ended up in
    // the live database.
    if (clientSecret && looksLikePlaceholder(clientSecret)) {
      return res.status(400).json({
        code: 'BAD_REQUEST',
        message: 'That Client Secret is documentation text, not a real value. Copy it from Google Cloud -> APIs & Services -> Credentials -> your OAuth 2.0 Client IDs -> "Client secret".',
      })
    }
    if (looksLikePlaceholder(clientId)) {
      return res.status(400).json({
        code: 'BAD_REQUEST',
        message: 'That Client ID is documentation text, not a real value. Copy the ID ending in ".apps.googleusercontent.com" from Google Cloud -> Credentials.',
      })
    }

    // Reuse the stored secret when the form only changes the client ID.
    let finalSecret = clientSecret
    let reusedPlaceholderSecret = false
    if (!finalSecret) {
      const previous = await prisma.providerConfig.findFirst({
        where: { userId: null, provider: 'google_drive' },
        orderBy: { createdAt: 'desc' },
      })
      if (previous) {
        try {
          const stored = decryptText(previous.clientSecretEncrypted)
          // Only reuse a secret that is actually usable - reusing a placeholder is
          // what kept the deployment broken after a "successful" save.
          if (looksLikePlaceholder(stored)) reusedPlaceholderSecret = true
          else finalSecret = stored
        } catch {
          // Stored with a different TOKEN_ENCRYPTION_KEY; ask for the secret again.
        }
      }
    }
    if (!finalSecret) {
      return res.status(400).json({
        code: 'BAD_REQUEST',
        message: reusedPlaceholderSecret
          ? 'The Client Secret currently stored is a placeholder, so it cannot be reused. Paste the real Client Secret from Google Cloud -> APIs & Services -> Credentials -> your OAuth 2.0 Client IDs.'
          : 'Client Secret is required. Paste it from Google Cloud -> APIs & Services -> Credentials -> your OAuth 2.0 Client IDs.',
      })
    }

    const clientIdEncrypted = encryptText(clientId)
    const clientSecretEncrypted = encryptText(finalSecret)

    // Write the new config first, then retire the old ones. The previous order
    // disabled the working config before creating the replacement, so a failed
    // save left Google sign-in broken with nothing to fall back to.
    const config = await prisma.providerConfig.create({
      data: { userId: null, provider: 'google_drive', clientIdEncrypted, clientSecretEncrypted, redirectUri, scopes, status: 'active' },
    })
    try {
      await prisma.providerConfig.updateMany({
        where: { userId: null, provider: 'google_drive', status: 'active', id: { not: config.id } },
        data: { status: 'disabled' },
      })
    } catch (cleanupError) {
      // Roll the new row back: keeping two active configs around is confusing, and
      // the old one is still the one Google accounts were linked against.
      await prisma.providerConfig.deleteMany({ where: { id: config.id } }).catch(() => undefined)
      throw cleanupError
    }

    // Prove the round trip: if the key cannot decrypt what we just wrote, the
    // credentials would silently fail at sign-in time.
    let verified = false
    try {
      verified = decryptText(config.clientIdEncrypted) === clientId && decryptText(config.clientSecretEncrypted) === finalSecret
    } catch {
      verified = false
    }
    if (!verified) {
      return res.status(500).json({
        code: 'CONFIG_NOT_VERIFIABLE',
        message: 'Credentials were saved but could not be read back. TOKEN_ENCRYPTION_KEY is probably missing or different from the one used before - set it and save again.',
      })
    }

    return res.status(201).json({
      status: 'success',
      message: `Google OAuth credentials saved. Add this exact URL to Google Cloud -> Credentials -> Authorized redirect URIs: ${redirectUri}`,
      id: config.id,
      clientId,
      redirectUri,
      hasSecret: true,
      existed: Boolean(config.id),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/unique constraint|P2002/i.test(message)) {
      return res.status(409).json({ code: 'CONFLICT', message: 'A Google config was created at the same moment. Reload the page and try again.' })
    }
    return next(error)
  }
})

systemRouter.get('/backup', requireAuth, (req, res, next) => {
  try {
    const dbPath = getDatabaseFilePath()
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Database file not found.' })
    }
    res.setHeader('Content-Disposition', 'attachment; filename=9drive-backup.db')
    res.setHeader('Content-Type', 'application/octet-stream')
    const fileStream = fs.createReadStream(dbPath)
    fileStream.pipe(res)
  } catch (error) {
    return next(error)
  }
})

systemRouter.post('/restore', requireAuth, (req, res, next) => {
  try {
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'multipart/form-data required.' })
    }

    const busboy = Busboy({ headers: req.headers, limits: { files: 1 } })
    let fileReceived = false

    busboy.on('file', (name, fileStream, info) => {
      fileReceived = true
      const dbPath = getDatabaseFilePath()
      const tempDbPath = dbPath + '.tmp'
      const writeStream = fs.createWriteStream(tempDbPath)

      fileStream.pipe(writeStream)

      writeStream.on('finish', async () => {
        try {
          // Disconnect prisma client first to release database lock
          await prisma.$disconnect()

          // Replace old database file with restored database file
          fs.renameSync(tempDbPath, dbPath)

          res.json({
            status: 'success',
            message: 'Database restored successfully. Server will restart in 2 seconds.'
          })

          // Graceful exit after response is sent
          setTimeout(() => {
            console.log('Database restored. Exiting to allow PM2 restart.')
            process.exit(0)
          }, 2000)

        } catch (err: any) {
          if (fs.existsSync(tempDbPath)) {
            try { fs.unlinkSync(tempDbPath) } catch {}
          }
          console.error('Failed to restore database:', err)
          return res.status(500).json({
            code: 'RESTORE_FAILED',
            message: 'Failed to restore database.',
            error: err.message
          })
        }
      })

      writeStream.on('error', (err) => {
        if (fs.existsSync(tempDbPath)) {
          try { fs.unlinkSync(tempDbPath) } catch {}
        }
        console.error('Write error on temp DB:', err)
        return res.status(500).json({
          code: 'WRITE_ERROR',
          message: 'Failed to write temporary database file.',
          error: err.message
        })
      })
    })

    busboy.on('error', (err) => {
      console.error('Busboy error:', err)
      if (!res.headersSent) {
        next(err)
      }
    })

    busboy.on('finish', () => {
      if (!fileReceived && !res.headersSent) {
        return res.status(400).json({ code: 'BAD_REQUEST', message: 'No file uploaded.' })
      }
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
})

function getDatabaseFilePath(): string {
  const dbUrl = process.env.DATABASE_URL || 'file:./dev.db'
  let cleanPath = dbUrl.replace(/^(sqlite|file):/, '')

  if (cleanPath.includes('?')) {
    cleanPath = cleanPath.split('?')[0]
  }

  if (!path.isAbsolute(cleanPath)) {
    let baseDir = path.resolve(process.cwd(), 'prisma')
    if (!fs.existsSync(baseDir)) {
      baseDir = path.resolve(process.cwd(), 'backend', 'prisma')
    }
    if (!fs.existsSync(baseDir)) {
      baseDir = path.resolve(process.cwd(), '..', 'backend', 'prisma')
    }
    return path.resolve(baseDir, cleanPath)
  }

  return cleanPath
}
