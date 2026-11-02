import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { classifyGoogleError, describeGoogleError, type ConnectFailure } from '../google/google-error.js'
import { repairStoredRedirectUri, requestOrigin, resolveGoogleRedirectUri } from '../google/redirect-uri.js'
import { redirectToFrontend } from '../../utils/redirect.js'
import { describeS3Error, listS3BucketNames, syncS3Quota, testS3Connection } from '../s3/s3.service.js'
import { getStoragePreset, listStoragePresets, normalizeEndpoint, resolveActivePreset, resolvePresetCredentials, storageBackendIds } from '../s3/presets.js'
import { looksLikePlaceholder } from '../../utils/placeholder.js'

export const connectedAccountRouter = Router()

/**
 * `provider` names a backend described by the environment (`B2_*`, `IDRIVE_E2_*`,
 * `DBRIJ_*`, `S3_*`). The other fields then become overrides: anything left blank is
 * filled from the environment, so the browser never has to send a secret it does
 * not know.
 */
const s3ConnectSchema = z.object({
  // Validated against the preset registry below, so adding a backend is a one-line
  // change there instead of an edit to this schema as well.
  provider: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(191).optional(),
  bucket: z.string().trim().min(1).max(191).optional(),
  region: z.string().trim().min(1).max(191).optional(),
  // Not `z.string().url()`: a bare host (`s3.<region>.backblazeb2.com`) is a
  // perfectly usable endpoint and was rejected here before normalisation could add
  // the scheme. Normalisation + validation happen together below.
  endpoint: z.string().trim().max(500).optional().or(z.literal('')),
  accessKeyId: z.string().min(1).optional(),
  secretAccessKey: z.string().min(1).optional(),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

async function syncQuotaForAccount(account: { id: string; provider: string }) {
  if (account.provider === 's3') return syncS3Quota(account.id)
  return syncGoogleQuota(account.id)
}

connectedAccountRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    // A freshly connected bucket must appear immediately, not after a browser
    // decides its cached JSON is still good.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, status: 'connected' },
      include: { storageAccount: true },
      orderBy: { createdAt: 'desc' },
    })
    const missingQuota = accounts.filter((account) => !account.storageAccount?.lastSyncedAt)
    for (const account of missingQuota) await syncQuotaForAccount(account).catch(() => undefined)

    const syncedAccounts = missingQuota.length > 0
      ? await prisma.connectedAccount.findMany({
        where: { userId: req.user!.id, status: 'connected' },
        include: { storageAccount: true },
        orderBy: { createdAt: 'desc' },
      })
      : accounts

    return res.json({
      accounts: syncedAccounts.map(({ accessTokenEncrypted: _a, refreshTokenEncrypted: _r, storageAccount, ...account }) => ({
        ...account,
        storageAccount: storageAccount ? {
          ...storageAccount,
          totalBytes: storageAccount.totalBytes?.toString() ?? null,
          usedBytes: storageAccount.usedBytes.toString(),
          availableBytes: storageAccount.availableBytes?.toString() ?? null,
          trashBytes: storageAccount.trashBytes?.toString() ?? null,
        } : null,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

async function createGoogleConnectUrl(req: AuthRequest): Promise<string | null> {
  const query = z.object({
    providerConfigId: z.string().min(1).optional(),
  }).parse(req.query)

  const config = query.providerConfigId
    ? await prisma.providerConfig.findFirst({
        where: {
          id: query.providerConfigId,
          OR: [{ userId: req.user!.id }, { userId: null }],
          provider: 'google_drive',
          status: 'active',
        },
      })
    : await prisma.providerConfig.findFirst({
        where: {
          userId: null,
          provider: 'google_drive',
          status: 'active',
        },
        orderBy: { createdAt: 'desc' },
      })

  // No matching active Google Drive configuration exists.
  // Return null so the route can respond with a clear 404.
  if (!config) return null

  const state = randomToken()
  await prisma.oauthState.create({
    data: {
      userId: req.user!.id,
      providerConfigId: config.id,
      flow: 'connect',
      stateHash: hashToken(state),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    },
  })

  const redirectUri = resolveGoogleRedirectUri(req, config.redirectUri)
  void repairStoredRedirectUri(config.id, config.redirectUri, redirectUri)

  const client = createOAuthClient(config, redirectUri)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
    redirect_uri: redirectUri,
  })
}

/**
 * Which storage backends this deployment can connect, from its environment.
 *
 * The Settings form uses this to offer "connect Backblaze B2" instead of six
 * hand-typed fields. Secrets are reported as `hasSecretKey: true`, never as
 * values - they stay on the server.
 */
connectedAccountRouter.get('/s3/presets', requireAuth, async (_req, res) => {
  // Never cached, and stamped with the moment it was read: a backend appears as
  // soon as its variables exist, and a cached copy is indistinguishable from
  // "the new backend was not updated". `readAt` lets the Settings modal show the
  // age of what it is displaying instead of guessing.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.set('Pragma', 'no-cache')
  return res.json({
    presets: listStoragePresets(),
    active: resolveActivePreset()?.id ?? null,
    selected: process.env.STORAGE_BACKEND?.trim() || null,
    readAt: new Date().toISOString(),
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
  })
})

connectedAccountRouter.post('/s3', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)

    /**
     * Resolve the backend: `provider` names an environment-described one, and any
     * field the form left blank comes from there. A manually typed value always
     * wins, so a user can point a preset at a different bucket.
     */
    /**
     * Only use the environment when the caller asked for it: a named `provider`, or
     * a body with no connection details at all (an API client relying on
     * `STORAGE_BACKEND`). A manual form entry never silently inherits an endpoint
     * from a different backend.
     */
    const wantsEnvironment = Boolean(body.provider) || (!body.bucket && !body.accessKeyId && !body.endpoint)
    const preset = body.provider ? getStoragePreset(body.provider) : wantsEnvironment ? resolveActivePreset() : null
    if (body.provider && !preset) {
      return res.status(400).json({
        code: 'STORAGE_BACKEND_UNKNOWN',
        message: `Unknown storage backend "${body.provider}". Use one of: ${storageBackendIds().join(', ')}.`,
      })
    }
    if (preset && !preset.ready && !(body.bucket && body.accessKeyId && body.secretAccessKey)) {
      return res.status(400).json({
        code: 'STORAGE_BACKEND_INCOMPLETE',
        message: `The ${preset.label} credentials in this deployment's environment are incomplete. Missing or placeholder: ${preset.missing.join(', ')}. Set them on the service and redeploy, or type the connection details here.`,
        missing: preset.missing,
      })
    }

    const presetCredentials = preset && preset.ready ? resolvePresetCredentials(preset.id) : null

    const declaredBucket = body.bucket ?? preset?.bucket ?? ''
    const region = body.region ?? preset?.region ?? ''
    // A typed endpoint is normalised the same way the environment's is: a bare host
    // (`s3.ca-east-006.backblazeb2.com`) becomes https://… instead of failing in the
    // SDK with "Invalid URL".
    const rawEndpoint = (body.endpoint || preset?.endpoint || '').trim()
    const endpoint = normalizeEndpoint(rawEndpoint) ?? ''
    if (rawEndpoint && !endpoint) {
      return res.status(400).json({
        code: 'S3_ENDPOINT_INVALID',
        message: `"${rawEndpoint}" is not a usable endpoint URL. Use the S3 API host only, for example https://s3.us-west-004.backblazeb2.com (no bucket name, no path).`,
      })
    }
    const accessKeyId = body.accessKeyId ?? presetCredentials?.accessKeyId ?? ''
    const secretAccessKey = body.secretAccessKey ?? presetCredentials?.secretAccessKey ?? ''
    const forcePathStyle = body.forcePathStyle ?? preset?.forcePathStyle ?? Boolean(endpoint)
    const quotaBytes = body.quotaBytes ?? preset?.quotaBytes ?? null

    /**
     * No bucket named, but the credentials and the endpoint are there: ask the
     * account which buckets it holds. A provider block written for the AWS CLI
     * (`AWS_ACCESS_KEY_ID`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`) never contains the
     * bucket, and the name is the one thing that cannot be derived.
     */
    let discoveredBucket = ''
    if (!declaredBucket && accessKeyId && secretAccessKey) {
      try {
        const names = await listS3BucketNames({ region, endpoint, forcePathStyle, accessKeyId, secretAccessKey })
        if (names.length === 1) {
          discoveredBucket = names[0]
        } else if (names.length === 0) {
          return res.status(400).json({
            code: 'S3_NO_BUCKETS',
            message: `The credentials are valid, but ${endpoint || `AWS ${region}`} has no buckets yet. Create one in the provider's console and connect again.`,
          })
        } else {
          return res.status(400).json({
            code: 'S3_BUCKET_AMBIGUOUS',
            message: `The credentials can see ${names.length} buckets: ${names.join(', ')}. Set the bucket field (or S3_BUCKET on the service) to the one to use.`,
            buckets: names,
          })
        }
      } catch (error) {
        // Listing can be denied while a specific bucket is still readable, so this
        // is reported as "we could not work out the bucket" rather than a dead end.
        const described = describeS3Error(error, { bucket: '(no bucket given)', endpoint, region })
        return res.status(400).json({
          code: described.code === 'S3_AUTH_FAILED' ? described.code : 'S3_BUCKET_UNKNOWN',
          message: `No bucket was given, and the account's buckets could not be listed: ${described.message}`,
        })
      }
    }
    const bucket = declaredBucket || discoveredBucket
    const name = body.name ?? preset?.name ?? `${bucket}`

    const missingFields = [
      !bucket ? 'bucket' : null,
      !region ? 'region' : null,
      !accessKeyId ? 'access key ID' : null,
      !secretAccessKey ? 'secret access key' : null,
    ].filter(Boolean)
    if (missingFields.length > 0) {
      return res.status(400).json({
        code: 'S3_FIELDS_MISSING',
        message: `Missing: ${missingFields.join(', ')}.${preset ? ` Set the ${preset.label} variables on the service, or fill the form.` : ''}`,
      })
    }
    // The Google OAuth incident in one line: a placeholder is not a credential.
    for (const [label, value] of [['bucket', bucket], ['region', region], ['access key ID', accessKeyId], ['secret access key', secretAccessKey]] as const) {
      if (looksLikePlaceholder(value)) {
        return res.status(400).json({
          code: 'S3_PLACEHOLDER_VALUE',
          message: `The ${label} looks like documentation text ("${value}"), not a real value. Copy it from your storage provider's console.`,
        })
      }
    }

    // S3 needs no Google Drive provider config. Requiring one used to make an
    // S3-only deployment impossible to set up.
    const googleConfig = await prisma.providerConfig.findFirst({
      where: { provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })

    const providerAccountId = `${bucket}:${endpoint || region}`
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 's3', providerAccountId } } })
    const account = existingAccount
      ? await prisma.connectedAccount.update({
        where: { id: existingAccount.id },
        data: {
          providerConfigId: googleConfig?.id ?? null,
          email: `${bucket} (S3)`,
          displayName: name,
          accessTokenEncrypted: encryptText('s3'),
          refreshTokenEncrypted: encryptText(randomToken()),
          tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          scopes: [],
          status: 'connected',
        },
      })
      : await prisma.connectedAccount.create({ data: {
        userId: req.user!.id,
        providerConfigId: googleConfig?.id ?? null,
        provider: 's3',
        providerAccountId,
        email: `${bucket} (S3)`,
        displayName: name,
        accessTokenEncrypted: encryptText('s3'),
        refreshTokenEncrypted: encryptText(randomToken()),
        tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
        scopes: [],
        status: 'connected',
      } })
    const config = await prisma.s3StorageConfig.upsert({
      where: { connectedAccountId: account.id },
      create: {
        userId: req.user!.id,
        connectedAccountId: account.id,
        name,
        bucket,
        region,
        endpoint: endpoint || null,
        accessKeyIdEncrypted: encryptText(accessKeyId),
        secretAccessKeyEncrypted: encryptText(secretAccessKey),
        forcePathStyle,
        quotaBytes: quotaBytes ? BigInt(quotaBytes) : null,
      },
      update: {
        name,
        bucket,
        region,
        endpoint: endpoint || null,
        accessKeyIdEncrypted: encryptText(accessKeyId),
        secretAccessKeyEncrypted: encryptText(secretAccessKey),
        forcePathStyle,
        quotaBytes: quotaBytes ? BigInt(quotaBytes) : null,
        status: 'active',
      },
    })
    try {
      await testS3Connection(config)
      const quota = await syncS3Quota(account.id)
      return res.status(201).json({
        account: {
          ...account,
          storageAccount: { ...quota, totalBytes: quota.totalBytes?.toString() ?? null, usedBytes: quota.usedBytes.toString(), availableBytes: quota.availableBytes?.toString() ?? null, trashBytes: quota.trashBytes?.toString() ?? null },
        },
      })
    } catch (error) {
      // A failed connection test must not leave a half-connected account behind.
      if (!existingAccount) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
      else await prisma.s3StorageConfig.update({ where: { connectedAccountId: account.id }, data: { status: 'error' } }).catch(() => undefined)

      const described = describeS3Error(error, { bucket, endpoint: endpoint || null, region })
      console.error(`[s3-connect] ${described.code}:`, error instanceof Error ? error.message : error)
      return res.status(400).json(described)
    }
  } catch (error) {
    return next(error)
  }
})

/**
 * The URL the popup is opened with. A missing OAuth client is a setup problem, so
 * it comes back as JSON with an instruction rather than a stack trace.
 */
connectedAccountRouter.get('/google/connect-url', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    if (!url) {
      return res.status(404).json({
        code: 'GOOGLE_PROVIDER_CONFIG_NOT_FOUND',
        message:
          'Google Drive is not connected yet because no OAuth client is configured. Save your Client ID and Secret in Settings -> Google OAuth Credentials (Redirect URI can stay empty), then try again.',
      })
    }
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/connect', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const url = await createGoogleConnectUrl(req)
    if (!url) {
      return res.status(404).json({
        code: 'GOOGLE_PROVIDER_CONFIG_NOT_FOUND',
        message:
          'Google Drive is not connected yet because no OAuth client is configured. Save your Client ID and Secret in Settings -> Google OAuth Credentials (Redirect URI can stay empty), then try again.',
      })
    }
    try {
      return res.redirect(url)
    } catch (error) {
      console.error('[google-connect] Google returned a URL that cannot be used as a redirect:', describeGoogleError(error))
      return res.status(500).json({ code: 'GOOGLE_URL_INVALID', message: 'The saved Google OAuth client settings look malformed. Re-save the Client ID and Secret in Settings -> Google OAuth Credentials.' })
    }
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res, next) => {
  /**
   * Every OAuth failure ends on the SPA's result page with a reason code - never a
   * bare 500 and never a blank screen. `redirectToFrontend` cannot throw.
   */
  const fail = (reason: ConnectFailure) => {
    console.error(`[google-callback] connect flow failed: ${reason}`)
    return redirectToFrontend(
      res,
      '/google-connected',
      { status: 'error', reason },
      {
        title: 'Connection failed',
        detail: `Google returned ${reason.toLowerCase().replace(/_/g, ' ')}. Close this tab and start the connection again.`,
      },
      requestOrigin(req),
    )
  }

  try {
    if (typeof req.query.error === 'string') {
      console.error('[google-callback] Google returned an error instead of a code:', req.query.error)
      return fail(req.query.error === 'access_denied' ? 'PERMISSION_DENIED' : 'TOKEN_EXCHANGE_FAILED')
    }
    console.log('[google-callback] connect callback hit', { hasCode: typeof req.query.code === 'string', hasState: typeof req.query.state === 'string' })

    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUnique({ where: { stateHash: hashToken(query.state) }, include: { providerConfig: true } })
    if (!oauthState) {
      console.error('[google-callback] unknown OAuth state - the link was reused, or the config changed between attempts')
      return fail('STATE_EXPIRED')
    }
    if (oauthState.usedAt || oauthState.expiresAt < new Date()) {
      console.error('[google-callback] OAuth state already used or expired', { usedAt: oauthState.usedAt, expiresAt: oauthState.expiresAt })
      return fail('STATE_EXPIRED')
    }

    const redirectUri = resolveGoogleRedirectUri(req, oauthState.providerConfig.redirectUri)
    void repairStoredRedirectUri(oauthState.providerConfig.id, oauthState.providerConfig.redirectUri, redirectUri)
    const client = createOAuthClient(oauthState.providerConfig, redirectUri)

    let tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }
    try {
      tokens = (await client.getToken(query.code)).tokens
    } catch (error) {
      const reason = classifyGoogleError(error)
      console.error('[google-callback] token exchange failed:', describeGoogleError(error))
      return fail(reason === 'UNKNOWN' ? 'TOKEN_EXCHANGE_FAILED' : reason)
    }
    if (!tokens.access_token) {
      console.error('[google-callback] Google returned no access token')
      return fail('TOKEN_EXCHANGE_FAILED')
    }
    client.setCredentials(tokens)

    let profile
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client })
      profile = await oauth2.userinfo.get()
    } catch (error) {
      console.error('[google-callback] userinfo failed:', describeGoogleError(error))
      return fail(classifyGoogleError(error))
    }
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) {
      console.error('[google-callback] Google profile is missing id or email')
      return fail('UNKNOWN')
    }

    if (oauthState.flow === 'login') {
      const name = profile.data.name || email.split('@')[0] || 'Google User'
      const user = await prisma.user.upsert({
        where: { email },
        create: { email, name, passwordHash: await hashPassword(randomToken(32)) },
        update: { name },
      })
      const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } } })
      const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
      if (!refreshTokenEncrypted) {
        console.error('Google login failed: no refresh token received and no existing account. Has refresh_token:', !!tokens.refresh_token)
        return redirectToFrontend(res, '/google-auth', { status: 'error', reason: 'INVALID_GRANT' }, undefined, requestOrigin(req))
      }
      const account = await prisma.connectedAccount.upsert({
        where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } },
        create: {
          userId: user.id,
          providerConfigId: oauthState.providerConfigId,
          provider: 'google_drive',
          providerAccountId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
        update: {
          providerConfigId: oauthState.providerConfigId,
          email,
          displayName: profile.data.name,
          avatarUrl: profile.data.picture,
          accessTokenEncrypted: encryptText(tokens.access_token),
          refreshTokenEncrypted,
          tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
          scopes: oauthState.providerConfig.scopes as string[],
          status: 'connected',
        },
      })
      await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date(), userId: user.id } })
      await syncGoogleQuota(account.id).catch(() => undefined)
      const handoffToken = randomToken()
      await prisma.authHandoff.create({ data: { userId: user.id, tokenHash: hashToken(handoffToken), expiresAt: new Date(Date.now() + 5 * 60_000) } })
      return redirectToFrontend(res, '/google-auth', { token: handoffToken }, undefined, requestOrigin(req))
    }

    if (oauthState.flow !== 'connect' || !oauthState.userId) {
      console.error('[google-callback] state is not a connect flow', { flow: oauthState.flow, userId: oauthState.userId })
      return fail('STATE_EXPIRED')
    }

    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } } })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) {
      console.error('[google-callback] Google returned no refresh token and there is no stored one - consent was not given offline access')
      return fail('INVALID_GRANT')
    }

    const account = await prisma.connectedAccount.upsert({
      where: { userId_provider_providerAccountId: { userId: oauthState.userId, provider: 'google_drive', providerAccountId } },
      create: {
        userId: oauthState.userId,
        providerConfigId: oauthState.providerConfigId,
        provider: 'google_drive',
        providerAccountId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
      update: {
        providerConfigId: oauthState.providerConfigId,
        email,
        displayName: profile.data.name,
        avatarUrl: profile.data.picture,
        accessTokenEncrypted: encryptText(tokens.access_token),
        refreshTokenEncrypted,
        tokenExpiresAt: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
        scopes: oauthState.providerConfig.scopes as string[],
        status: 'connected',
      },
    })
    await prisma.oauthState.update({ where: { id: oauthState.id }, data: { usedAt: new Date() } })

    // The account is connected at this point. A failing quota read (Drive API not
    // enabled, transient 5xx, rate limit) must not turn a success into an error
    // screen - it only means the storage numbers are missing until the next sync.
    let quotaReason: ConnectFailure | null = null
    try {
      await syncGoogleQuota(account.id)
    } catch (error) {
      quotaReason = classifyGoogleError(error)
      console.error(`[google-callback] account ${account.id} connected, but the quota sync failed (${quotaReason}):`, describeGoogleError(error))
    }

    return redirectToFrontend(
      res,
      '/google-connected',
      { status: 'success', quota: quotaReason ? 'failed' : 'ok', reason: quotaReason },
      {
        title: 'Drive connected',
        detail: 'The account was connected. Open Settings to see it.',
      },
      requestOrigin(req),
    )
  } catch (error) {
    console.error('[google-callback] unexpected failure:', describeGoogleError(error), error)
    return fail(classifyGoogleError(error))
  }
})

connectedAccountRouter.post('/:id/sync-quota', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    const account = await prisma.connectedAccount.findFirstOrThrow({ where: { id: accountId, userId: req.user!.id } })
    const quota = await syncQuotaForAccount(account)
    return res.json({
      quota: {
        ...quota,
        totalBytes: quota.totalBytes?.toString() ?? null,
        usedBytes: quota.usedBytes.toString(),
        availableBytes: quota.availableBytes?.toString() ?? null,
        trashBytes: quota.trashBytes?.toString() ?? null,
      },
    })
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.delete('/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const accountId = String(req.params.id)
    await prisma.connectedAccount.updateMany({ where: { id: accountId, userId: req.user!.id }, data: { status: 'disconnected' } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
