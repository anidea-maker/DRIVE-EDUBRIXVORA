import type { Request } from 'express'

/** The two things needed to know an origin; `Request` satisfies this. */
export type OriginSource = { protocol?: string; get(name: string): string | undefined }
import { prisma } from '../../config/prisma.js'
import { GOOGLE_CALLBACK_PATH, checkRedirectUri } from './config-health.js'

/**
 * Which `redirect_uri` to send Google.
 *
 * The stored value used to be sent verbatim. That is how a deployment ended up
 * asking Google to redirect to `https://<new-service>.onrender.com/...`: a
 * placeholder from the docs had been saved, and no request ever noticed. Google
 * validates the URI before showing the consent screen, so the user simply could
 * not connect.
 *
 * Now the origin of the request in flight always wins. The browser arrived on that
 * host, so it is by definition the host Google must come back to - and it is the
 * URI the operator registered in Google Cloud.
 */

/** `https://host` for this request, upgraded to https for anything non-local. */
export function requestOrigin(req: OriginSource): string | null {
  const proto = (req.protocol || 'https').split(',')[0].trim().toLowerCase()
  const host = String(req.get('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0].trim()
  if (!host) return null
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
  const scheme = proto === 'http' && !isLocal ? 'https' : proto || 'https'
  return `${scheme}://${host}`
}

/** Configs already corrected in this process, so the repair runs once each. */
const repaired = new Set<string>()

/**
 * The redirect URI Google will be given: this request's own origin, unless that
 * origin is not usable (then the stored value, if it is).
 */
export function resolveGoogleRedirectUri(req: OriginSource, stored: string | null | undefined): string {
  const origin = requestOrigin(req)
  const fromOrigin = origin ? checkRedirectUri(`${origin}${GOOGLE_CALLBACK_PATH}`) : null
  const fromStore = checkRedirectUri(stored)

  if (fromOrigin?.ok) {
    if (!fromStore.ok) {
      console.warn(`[google-oauth] ignoring the saved redirect URI (${fromStore.problem}) and using ${fromOrigin.uri}`)
    } else if (fromStore.uri !== fromOrigin.uri) {
      console.warn(`[google-oauth] saved redirect URI ${fromStore.uri} does not match this host - using ${fromOrigin.uri}`)
    }
    return fromOrigin.uri
  }

  if (fromStore.ok) return fromStore.uri

  // Nothing usable: keep the old value rather than inventing one, but say why.
  console.error(`[google-oauth] no usable redirect URI. ${fromOrigin && !fromOrigin.ok ? fromOrigin.problem : 'No request origin.'} ${!fromStore.ok ? fromStore.problem : ''}`)
  return String(stored ?? '')
}

/**
 * Persist the corrected URI so `/api/auth/google/status`, the Settings page and the
 * diagnostics endpoint stop reporting the broken value. Best-effort: a read-only
 * database or a deleted config must not break the request.
 */
export async function repairStoredRedirectUri(configId: string, current: string | null | undefined, resolved: string): Promise<void> {
  if (!configId || current === resolved || repaired.has(configId)) return
  repaired.add(configId)
  try {
    await prisma.providerConfig.update({ where: { id: configId }, data: { redirectUri: resolved } })
    console.log(`[google-oauth] saved redirect URI repaired: ${current ?? '(empty)'} -> ${resolved}`)
  } catch (error) {
    console.warn('[google-oauth] could not repair the saved redirect URI:', error instanceof Error ? error.message : error)
  }
}
