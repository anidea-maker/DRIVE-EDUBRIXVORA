import type { ProviderConfig } from '@prisma/client'
import { prisma } from '../config/prisma.js'
import { encryptText } from '../utils/crypto.js'
import { toJsonArrayColumn } from '../utils/json-column.js'
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_CLIENT_ID_PATTERN,
  describeConfigProblem,
  looksLikePlaceholder,
  platformOrigin,
} from '../modules/google/config-health.js'

/**
 * Boot-time Google OAuth config: seed it from the environment when the environment
 * is usable, and otherwise make sure the *working* configuration saved through
 * Settings stays active.
 *
 * The bug this fixes: the deployment ran with `GOOGLE_CLIENT_ID=<client id>` and
 * `GOOGLE_REDIRECT_URI=https://<new-service>.onrender.com/...` (documentation
 * placeholders). The old seed disabled every existing config and installed the
 * placeholders, so a working client saved through the UI was silently retired and
 * every authorization URL carried `client_id=<client id>`. Google refused before
 * the app saw a request, and Connect Drive could not work at all.
 *
 * Rules now:
 *   1. Placeholder/invalid environment values are ignored - never seeded, and they
 *      never disable anything.
 *   2. New configurations are written before old ones are retired, so a failed
 *      write cannot leave the deployment with no usable client.
 *   3. Whatever happens, the newest *usable* configuration is left active.
 */

const scopes = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

function environmentCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() ?? ''
  const rawRedirect = process.env.GOOGLE_REDIRECT_URI?.trim() ?? ''
  const origin = platformOrigin() ?? (process.env.NODE_ENV === 'production' ? null : 'http://localhost:4000')
  const redirectUri = rawRedirect && !looksLikePlaceholder(rawRedirect)
    ? rawRedirect
    : origin
      ? `${origin}${GOOGLE_CALLBACK_PATH}`
      : ''

  const problems: string[] = []
  if (!clientId) problems.push('GOOGLE_CLIENT_ID is not set')
  else if (looksLikePlaceholder(clientId) || !GOOGLE_CLIENT_ID_PATTERN.test(clientId)) {
    problems.push(`GOOGLE_CLIENT_ID (${clientId}) is a placeholder, not an OAuth client ID`)
  }
  if (!clientSecret) problems.push('GOOGLE_CLIENT_SECRET is not set')
  else if (looksLikePlaceholder(clientSecret)) problems.push('GOOGLE_CLIENT_SECRET is a placeholder')
  if (!redirectUri) problems.push('GOOGLE_REDIRECT_URI is not set and this host has no public origin')

  return { clientId, clientSecret, redirectUri, problems }
}

async function activeConfigs(): Promise<ProviderConfig[]> {
  return prisma.providerConfig.findMany({
    where: { userId: null, provider: 'google_drive' },
    orderBy: { createdAt: 'desc' },
  })
}

async function main() {
  const { clientId, clientSecret, redirectUri, problems } = environmentCredentials()
  /** The config written from the environment in this run, if any. */
  let seededId: string | null = null

  if (problems.length > 0) {
    console.warn(`[google-seed] not seeding from the environment: ${problems.join('; ')}`)
    console.warn('[google-seed] Any Google client saved through Settings -> Google OAuth Credentials stays in charge.')
  } else {
    const existing = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' },
    })
    const unchanged = existing
      ? describeConfigProblem(existing) === null && existing.redirectUri === redirectUri
      : false

    if (unchanged) {
      console.log('[google-seed] the active Google config already matches the environment - nothing to do.')
    } else {
      // Create first, retire later: a failure here must not remove the only client.
      const created = await prisma.providerConfig.create({
        data: {
          userId: null,
          provider: 'google_drive',
          clientIdEncrypted: encryptText(clientId),
          clientSecretEncrypted: encryptText(clientSecret),
          redirectUri,
          scopes: toJsonArrayColumn(scopes),
          status: 'active',
        },
      })
      await prisma.providerConfig.updateMany({
        where: { userId: null, provider: 'google_drive', status: 'active', id: { not: created.id } },
        data: { status: 'disabled' },
      })
      seededId = created.id
      console.log(`[google-seed] seeded the global Google Drive config from the environment: ${created.id} (redirect ${redirectUri})`)
    }
  }

  // --- make sure a usable client is active -------------------------------------
  const configs = await activeConfigs()
  // A config just written from the environment wins over everything else, so the
  // recovery pass below cannot undo the seed it just performed.
  const ordered = seededId
    ? [...configs].sort((a, b) => (a.id === seededId ? -1 : b.id === seededId ? 1 : 0))
    : configs
  if (configs.length === 0) {
    console.warn('[google-seed] there is no Google OAuth client at all. Add one in Settings -> Google OAuth Credentials, or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.')
    return
  }

  const usable = ordered.find((config) => {
    const problem = describeConfigProblem(config)
    if (problem) {
      console.warn(`[google-seed] config ${config.id} is not usable: ${problem}`)
      return false
    }
    return true
  })

  if (!usable) {
    console.warn('[google-seed] no usable Google OAuth client - Connect Drive will fail until one is saved in Settings.')
    return
  }

  if (usable.status !== 'active') {
    await prisma.providerConfig.update({ where: { id: usable.id }, data: { status: 'active' } })
  }
  // Keep exactly one active global config, and make it the usable one.
  const retired = await prisma.providerConfig.updateMany({
    where: { userId: null, provider: 'google_drive', status: 'active', id: { not: usable.id } },
    data: { status: 'disabled' },
  })
  if (retired.count > 0) {
    console.warn(`[google-seed] reactivated the last working Google client (${usable.id}) and retired ${retired.count} unusable one(s).`)
  } else {
    console.log(`[google-seed] active Google config: ${usable.id} (redirect ${usable.redirectUri})`)
  }
}

main()
  .catch((error) => {
    console.error('[google-seed] failed:', error)
    // Never exit non-zero on boot: a broken Google client must not stop the API,
    // or nobody can sign in with email/password either.
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
