import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { hashPassword } from '../../utils/password.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
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

  const client = createOAuthClient(config)
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: config.scopes as string[],
    state,
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
 * Turns a failure from Google (or from the quota read) into a short code the
 * frontend can explain. The previous catch-all redirected with `status=error`
 * and nothing else, so a disabled Drive API looked identical to a broken build.
 */
type ConnectFailure = 'STATE_EXPIRED' | 'DRIVE_API_DISABLED' | 'PERMISSION_DENIED' | 'INVALID_GRANT' | 'TOKEN_EXCHANGE_FAILED' | 'QUOTA_SYNC' | 'UNKNOWN'

function classifyGoogleError(error: unknown): ConnectFailure {
  const err = error as {
    code?: number
    status?: number
    message?: string
    errors?: Array<{ reason?: string; message?: string }>
    response?: { data?: { error?: { status?: string; message?: string; errors?: Array<{ reason?: string }> } } }
  } | null

  const status = err?.code ?? err?.status ?? err?.response?.data?.error?.status
  const reasons = [
    ...(err?.errors?.map((e) => e.reason) ?? []),
    ...(err?.response?.data?.error?.errors?.map((e) => e.reason) ?? []),
    err?.response?.data?.error?.status,
    err?.message,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/has not been used|is disabled|accessnotconfigured|service_disabled|drive api/.test(reasons)) return 'DRIVE_API_DISABLED'
  if (/insufficient|permission|forbidden/.test(reasons) || status === 403) return 'PERMISSION_DENIED'
  if (/invalid_grant|revoked|expired/.test(reasons)) return 'INVALID_GRANT'
  if (/invalid_scope|invalid_request|redirect_uri_mismatch/.test(reasons)) return 'TOKEN_EXCHANGE_FAILED'
  return 'UNKNOWN'
}

/** Human-readable one-liner for the server log. */
function describeGoogleError(error: unknown): string {
  const err = error as { code?: number; message?: string; errors?: Array<{ reason?: string }> } | null
  const reason = err?.errors?.map((e) => e.reason).filter(Boolean).join(', ')
  return [err?.code, reason, err?.message].filter(Boolean).join(' | ') || String(error)
}

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
    return res.redirect(url)
  } catch (error) {
    return next(error)
  }
})

connectedAccountRouter.get('/google/callback', async (req, res, next) => {
  const fail = (reason: ConnectFailure) => res.redirect(`${env.FRONTEND_URL}/google-connected?status=error&reason=${reason}`)

  try {
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

    const client = createOAuthClient(oauthState.providerConfig)

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
        return res.redirect(`${env.FRONTEND_URL}/google-auth?status=error&reason=INVALID_GRANT`)
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
      return res.redirect(`${env.FRONTEND_URL}/google-auth?token=${handoffToken}`)
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

    const params = new URLSearchParams({ status: 'success', quota: quotaReason ? 'failed' : 'ok' })
    if (quotaReason) params.set('reason', quotaReason)
    return res.redirect(`${env.FRONTEND_URL}/google-connected?${params.toString()}`)
  } catch (error) {
    console.error('Google OAuth callback failed:', describeGoogleError(error))
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
