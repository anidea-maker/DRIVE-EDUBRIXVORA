import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashPassword, verifyPassword } from '../../utils/password.js'
import { encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { signAccessToken } from '../../utils/jwt.js'
import { createOAuthClient, syncGoogleQuota } from '../google/google.service.js'
import { classifyGoogleError, describeGoogleError, type ConnectFailure } from '../google/google-error.js'
import { redirectToFrontend } from '../../utils/redirect.js'

export const authRouter = Router()

const registerSchema = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) })
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) })
const refreshSchema = z.object({ refreshToken: z.string().min(1) })
const googleExchangeSchema = z.object({ token: z.string().min(1) })

async function createSession(userId: string, req: AuthRequest) {
  const refreshToken = randomToken()
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  const session = await prisma.userSession.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: req.header('User-Agent'),
      ipAddress: req.ip,
      expiresAt,
    },
  })
  return { accessToken: signAccessToken({ sub: userId, sid: session.id }), refreshToken }
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body)
    const existing = await prisma.user.findUnique({ where: { email: body.email } })
    if (existing) return res.status(409).json({ code: 'AUTH_EMAIL_TAKEN', message: 'Email already registered.' })
    const user = await prisma.user.create({ data: { name: body.name, email: body.email, passwordHash: await hashPassword(body.password) } })
    const tokens = await createSession(user.id, req)
    return res.status(201).json({ ...tokens, user: { id: user.id, name: user.name, email: user.email } })
  } catch (error) {
    return next(error)
  }
})

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: body.email } })
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) return res.status(401).json({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password.' })
    const tokens = await createSession(user.id, req)
    return res.json({ ...tokens, user: { id: user.id, name: user.name, email: user.email } })
  } catch (error) {
    return next(error)
  }
})

/**
 * Is Google sign-in usable right now? Public (no auth): the login/register pages
 * ask this so they can explain what is missing instead of bouncing the user to a
 * provider that was never configured. No secrets are exposed.
 */
authRouter.get('/google/status', async (req, res, next) => {
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
      select: { redirectUri: true },
    })

    // The redirect URI is stored in the database and handed to Google verbatim,
    // so one saved while running locally (or on an old host) breaks sign-in with
    // redirect_uri_mismatch on the deployed site. Report it instead of guessing.
    const origin = `${req.protocol}://${req.get('host')}`
    const expected = `${origin}/connected-accounts/google/callback`
    const redirectUri = config?.redirectUri ?? null
    const matchesOrigin = redirectUri ? redirectUri === expected : false

    const hint = !config
      ? 'Add your Google OAuth client ID and secret in Settings -> Google Credentials, or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET and redeploy.'
      : matchesOrigin
        ? null
        : `The saved redirect URI (${redirectUri}) does not match this site (${expected}). Open Settings -> Google OAuth Credentials, leave the Redirect URI field empty and save again to use the current origin.`

    return res.json({ configured: Boolean(config), redirectUri, expectedRedirectUri: expected, redirectUriMatchesOrigin: matchesOrigin, hint })
  } catch (error) {
    return next(error)
  }
})

authRouter.get('/google/url', async (_req, res, next) => {
  try {
    // findFirst (not findFirstOrThrow): a missing config is a setup problem, and it
    // must not reach the browser as a Prisma stack trace.
    const config = await prisma.providerConfig.findFirst({ where: { userId: null, provider: 'google_drive', status: 'active' }, orderBy: { createdAt: 'desc' } })
    if (!config) {
      return res.status(409).json({
        code: 'GOOGLE_NOT_CONFIGURED',
        message: 'Google sign-in is not set up yet. Add your Google OAuth client ID and secret in Settings -> Google Credentials, then try again.',
      })
    }
    const state = randomToken()
    await prisma.oauthState.create({ data: { providerConfigId: config.id, flow: 'login', stateHash: hashToken(state), expiresAt: new Date(Date.now() + 10 * 60_000) } })
    const client = createOAuthClient(config)
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: config.scopes as string[],
      state,
    })
    return res.json({ url })
  } catch (error) {
    return next(error)
  }
})

authRouter.get('/google/callback', async (req, res) => {
  /**
   * Sign-in failures have to end on the SPA, never on a blank 500. This route used
   * to fall through with `findUniqueOrThrow` + a bare `res.redirect()` inside its
   * catch, so an expired link (or a mistyped FRONTEND_URL) produced HTTP 500 with
   * no message at all - the browser just showed an empty page.
   */
  const fail = (reason: ConnectFailure) => {
    console.error(`[google-auth-callback] sign-in failed: ${reason}`)
    return redirectToFrontend(
      res,
      '/google-auth',
      { status: 'error', reason },
      {
        title: 'Google sign-in failed',
        detail: 'Close this tab and try signing in again.',
      },
    )
  }

  try {
    console.log('[google-auth-callback] sign-in callback hit', { hasCode: typeof req.query.code === 'string', hasState: typeof req.query.state === 'string' })
    // Google sends ?error=access_denied when the user cancels the consent screen.
    const denial = typeof req.query.error === 'string' ? req.query.error : ''
    if (denial) {
      console.error('[google-auth-callback] Google returned an error instead of a code:', denial)
      return fail(denial === 'access_denied' ? 'PERMISSION_DENIED' : 'TOKEN_EXCHANGE_FAILED')
    }

    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query)
    const oauthState = await prisma.oauthState.findUnique({
      where: { stateHash: hashToken(query.state) },
      include: { providerConfig: true },
    })
    if (!oauthState) {
      console.error('[google-auth-callback] unknown OAuth state - the sign-in link was reused or the config changed')
      return fail('STATE_EXPIRED')
    }
    if (oauthState.flow !== 'login' || oauthState.usedAt || oauthState.expiresAt < new Date()) {
      console.error('[google-auth-callback] state is not a usable login state', {
        flow: oauthState.flow,
        usedAt: oauthState.usedAt,
        expiresAt: oauthState.expiresAt,
      })
      return fail('STATE_EXPIRED')
    }

    const client = createOAuthClient(oauthState.providerConfig)

    let tokens: { access_token?: string | null; refresh_token?: string | null; expiry_date?: number | null }
    try {
      tokens = (await client.getToken(query.code)).tokens
    } catch (error) {
      console.error('[google-auth-callback] token exchange failed:', describeGoogleError(error))
      const reason = classifyGoogleError(error)
      return fail(reason === 'UNKNOWN' ? 'TOKEN_EXCHANGE_FAILED' : reason)
    }
    if (!tokens.access_token) {
      console.error('[google-auth-callback] Google returned no access token')
      return fail('TOKEN_EXCHANGE_FAILED')
    }
    client.setCredentials(tokens)

    let profile
    try {
      profile = await google.oauth2({ version: 'v2', auth: client }).userinfo.get()
    } catch (error) {
      console.error('[google-auth-callback] userinfo failed:', describeGoogleError(error))
      return fail(classifyGoogleError(error))
    }
    const providerAccountId = profile.data.id
    const email = profile.data.email
    if (!providerAccountId || !email) {
      console.error('[google-auth-callback] Google profile is missing id or email')
      return fail('UNKNOWN')
    }

    const name = profile.data.name || email.split('@')[0] || 'Google User'
    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name, passwordHash: await hashPassword(randomToken(32)) },
      update: { name },
    })
    const existingAccount = await prisma.connectedAccount.findUnique({ where: { userId_provider_providerAccountId: { userId: user.id, provider: 'google_drive', providerAccountId } } })
    const refreshTokenEncrypted = tokens.refresh_token ? encryptText(tokens.refresh_token) : existingAccount?.refreshTokenEncrypted
    if (!refreshTokenEncrypted) {
      console.error('[google-auth-callback] no refresh token and no stored account - consent was not for offline access')
      return fail('INVALID_GRANT')
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
    return redirectToFrontend(res, '/google-auth', { token: handoffToken })
  } catch (error) {
    console.error('[google-auth-callback] unexpected failure:', describeGoogleError(error), error)
    return fail(classifyGoogleError(error))
  }
})

authRouter.post('/google/exchange', async (req, res, next) => {
  try {
    const body = googleExchangeSchema.parse(req.body)
    const handoff = await prisma.authHandoff.findFirst({ where: { tokenHash: hashToken(body.token), usedAt: null, expiresAt: { gt: new Date() } }, include: { user: true } })
    if (!handoff) return res.status(401).json({ code: 'AUTH_GOOGLE_HANDOFF_INVALID', message: 'Google login session expired.' })
    await prisma.authHandoff.update({ where: { id: handoff.id }, data: { usedAt: new Date() } })
    const tokens = await createSession(handoff.userId, req)
    return res.json({ ...tokens, user: { id: handoff.user.id, name: handoff.user.name, email: handoff.user.email } })
  } catch (error) {
    return next(error)
  }
})

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const body = refreshSchema.parse(req.body)
    const session = await prisma.userSession.findFirst({ where: { refreshTokenHash: hashToken(body.refreshToken), revokedAt: null, expiresAt: { gt: new Date() } } })
    if (!session) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Refresh token expired.' })
    return res.json({ accessToken: signAccessToken({ sub: session.userId, sid: session.id }) })
  } catch (error) {
    return next(error)
  }
})

authRouter.post('/logout', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await prisma.userSession.update({ where: { id: req.user!.sessionId }, data: { revokedAt: new Date() } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

authRouter.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, status: true } })
    return res.json({ user })
  } catch (error) {
    return next(error)
  }
})
