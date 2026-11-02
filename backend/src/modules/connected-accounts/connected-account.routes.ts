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
import { syncS3Quota, testS3Connection } from '../s3/s3.service.js'

export const connectedAccountRouter = Router()

const s3ConnectSchema = z.object({
  name: z.string().trim().min(1).max(191),
  bucket: z.string().trim().min(1).max(191),
  region: z.string().trim().min(1).max(191),
  endpoint: z.string().url().optional().or(z.literal('')),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  quotaBytes: z.string().regex(/^\d+$/).optional().nullable(),
})

async function syncQuotaForAccount(account: { id: string; provider: string }) {
  if (account.provider === 's3') return syncS3Quota(account.id)
  return syncGoogleQuota(account.id)
}

connectedAccountRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
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

connectedAccountRouter.post('/s3', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = s3ConnectSchema.parse(req.body)
    const providerConfig = await prisma.providerConfig.findFirst({
      where: { provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    if (!providerConfig) {
      return res.status(404).json({
        error: 'PROVIDER_CONFIG_NOT_FOUND',
        message: 'No active provider configuration is available for this storage connection.',
      })
    }

    const providerAccountId = `${body.bucket}:${body.endpoint || body.region}`
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: req.user!.id, provider: 's3', providerAccountId } } })
    const account = existingAccount
      ? await prisma.connectedAccount.update({
        where: { id: existingAccount.id },
        data: {
          providerConfigId: providerConfig.id,
          email: `${body.bucket} (S3)`,
          displayName: body.name,
          accessTokenEncrypted: encryptText('s3'),
          refreshTokenEncrypted: encryptText(randomToken()),
          tokenExpiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
          scopes: [],
          status: 'connected',
        },
      })
      : await prisma.connectedAccount.create({ data: {
        userId: req.user!.id,
        providerConfigId: providerConfig.id,
        provider: 's3',
        providerAccountId,
        email: `${body.bucket} (S3)`,
        displayName: body.name,
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
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
      },
      update: {
        name: body.name,
        bucket: body.bucket,
        region: body.region,
        endpoint: body.endpoint || null,
        accessKeyIdEncrypted: encryptText(body.accessKeyId),
        secretAccessKeyEncrypted: encryptText(body.secretAccessKey),
        forcePathStyle: body.forcePathStyle ?? Boolean(body.endpoint),
        quotaBytes: body.quotaBytes ? BigInt(body.quotaBytes) : null,
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
      if (!existingAccount) await prisma.connectedAccount.delete({ where: { id: account.id } }).catch(() => undefined)
      throw error
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
