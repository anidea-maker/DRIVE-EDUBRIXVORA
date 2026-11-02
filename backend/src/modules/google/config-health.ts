import type { ProviderConfig } from '@prisma/client'
import { decryptText } from '../../utils/crypto.js'

/**
 * Is a saved Google OAuth client actually usable?
 *
 * The live deployment booted with `GOOGLE_CLIENT_ID=<client id>` and
 * `GOOGLE_REDIRECT_URI=https://<new-service>.onrender.com/...` - the placeholders
 * from the documentation - and the boot seed happily wrote them to the database,
 * *disabling the real client that had been saved in Settings*. Every authorization
 * URL then carried `client_id=<client id>`, so Google refused before the app ever
 * saw a request.
 *
 * Validation therefore has to be shared: the Settings form, the boot seed and the
 * diagnostics endpoint must all agree on what "configured" means.
 */

/** Values that are documentation text rather than credentials. */
const PLACEHOLDER_TOKENS = [
  /<[^<>]*>/, // <client id>, <new-service>
  /\bclient[ _-]?id\b/i,
  /\bclient[ _-]?secret\b/i,
  /\byour[-_.]/i,
  /\bnew-service\b/i,
  /\bexample\.(com|org|net)\b/i,
  /\bchangeme\b/i,
  /\breplace[-_]?with\b/i,
  /\bxxxxxxxx/i,
  /^\s*$/,
]

export function looksLikePlaceholder(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true
  return PLACEHOLDER_TOKENS.some((pattern) => pattern.test(value))
}

/** Any OAuth *web* client ID ends in this suffix (Google documents the shape). */
export const GOOGLE_CLIENT_ID_PATTERN = /^[^\s<>]+\.apps\.googleusercontent\.com$/i

export const GOOGLE_CALLBACK_PATH = '/connected-accounts/google/callback'

export type RedirectUriCheck = { ok: true; uri: string } | { ok: false; problem: string }

/**
 * A redirect URI must be absolute, https (or http on localhost), have a real host,
 * and point at this app's callback route. `https://.onrender.com/...` and
 * `https://<new-service>.onrender.com/...` both fail here.
 */
export function checkRedirectUri(value: string | null | undefined): RedirectUriCheck {
  const uri = (value ?? '').trim()
  if (!uri) return { ok: false, problem: 'Redirect URI is empty.' }
  if (looksLikePlaceholder(uri)) {
    return { ok: false, problem: `Redirect URI "${uri}" is documentation text, not a real URL.` }
  }

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return { ok: false, problem: `Redirect URI "${uri}" is not a full URL.` }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, problem: `Redirect URI must start with https:// (got ${parsed.protocol}).` }
  }
  if (!parsed.hostname || parsed.hostname.startsWith('.') || parsed.hostname.endsWith('.')) {
    return { ok: false, problem: `Redirect URI "${uri}" has no valid host name.` }
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)
  if (parsed.protocol === 'http:' && !isLocal) {
    return { ok: false, problem: `Google rejects http:// redirect URIs (got ${uri}).` }
  }
  if (!parsed.pathname.endsWith(GOOGLE_CALLBACK_PATH)) {
    return { ok: false, problem: `Redirect URI must end with ${GOOGLE_CALLBACK_PATH} (got ${parsed.pathname}).` }
  }
  return { ok: true, uri: parsed.toString() }
}

/** What is wrong with this stored client, if anything. Secrets are never echoed. */
export function describeConfigProblem(config: Pick<ProviderConfig, 'clientIdEncrypted' | 'clientSecretEncrypted' | 'redirectUri'>): string | null {
  let clientId = ''
  let clientSecret = ''
  try {
    clientId = decryptText(config.clientIdEncrypted)
    clientSecret = decryptText(config.clientSecretEncrypted)
  } catch {
    return 'The saved client ID/secret cannot be decrypted - TOKEN_ENCRYPTION_KEY changed since they were saved. Save the credentials again.'
  }

  if (looksLikePlaceholder(clientId) || !GOOGLE_CLIENT_ID_PATTERN.test(clientId)) {
    return 'The saved Google Client ID is a placeholder or not an OAuth web client ID.'
  }
  if (looksLikePlaceholder(clientSecret)) {
    return 'The saved Google Client Secret is a placeholder.'
  }
  const redirect = checkRedirectUri(config.redirectUri)
  if (!redirect.ok) return redirect.problem
  return null
}

/** The origin this deployment is publicly reachable on, when the host knows it. */
export function platformOrigin(): string | null {
  const host =
    process.env.RENDER_EXTERNAL_HOSTNAME?.trim() ||
    process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ||
    process.env.FLY_APP_NAME?.trim().concat('.fly.dev') ||
    ''
  return host ? `https://${host}` : null
}
