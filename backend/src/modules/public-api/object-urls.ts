import type { Request } from 'express'
import { signObjectUrl, signedObjectPath, type SignedMethod } from './object-signing.js'
import { absoluteUrl } from './serialize.js'

/**
 * One place that turns an object key into a URL a browser can use directly.
 *
 * Why this exists: an external website needs `<img src>`, `<video src>` and
 * "download" links, and a browser cannot attach an `Authorization: Bearer` header
 * to those. Three shapes are supported, and the caller picks the one that fits:
 *
 *   signed  `/api/public/objects/<key>?…sig` - the link is the credential, bound to
 *           the API key row, the object, the method and an expiry. This is the
 *           default handed back by the listing endpoint, and the only form a
 *           browser can use.
 *   api     `GET /api/v1/objects/<key>` with the API key. Server-to-server only.
 *
 * There is deliberately no unsigned mode: object keys are unique per account,
 * not globally, so a key alone cannot identify an object. A permanent, keyless
 * link for one file is `POST /api/v1/files/:id/share`.
 *
 * `apiUrl` is always credential-free on purpose: a URL embedded in a listing is
 * forwarded, logged and cached far more casually than a header is.
 */
export type ObjectUrlPurpose = 'api' | 'signed'

export type ObjectUrlSet = {
  /** Object key these URLs address. */
  key: string
  /** Inline URL (no download disposition). Safe as `<img src>` / `<video src>`. */
  previewUrl: string
  /** Same content, served with `Content-Disposition: attachment`. */
  downloadUrl: string
  /** Absolute link to the API route, to be called with `Authorization: Bearer`. */
  apiUrl: string
  /** ISO timestamp for signed URLs; null for `api`. */
  expiresAt: string | null
}

const DEFAULT_TTL_SECONDS = 3600
const MIN_TTL_SECONDS = 30
const MAX_TTL_SECONDS = 604_800

export function clampUrlTtl(seconds: number | undefined): number {
  if (!Number.isFinite(seconds ?? NaN)) return DEFAULT_TTL_SECONDS
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.trunc(seconds as number)))
}

/** Percent-encodes each key segment, keeping the slashes that make it a path. */
export function encodeObjectPath(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * Builds the URL set for one key.
 *
 * @param apiKeyId the API key row that authorises the caller. Required for
 *   `signed` (the signature is bound to it, so revoking the key invalidates the
 *   link) and ignored otherwise.
 */
export function objectUrls(input: {
  req: Request
  userId: string
  key: string
  purpose: ObjectUrlPurpose
  apiKeyId?: string
  ttlSeconds?: number
  download?: boolean
}): ObjectUrlSet {
  const { req, userId, key, purpose } = input
  const apiUrl = absoluteUrl(req, `/api/v1/objects/${encodeObjectPath(key)}`)

  if (purpose === 'api') {
    return {
      key,
      previewUrl: apiUrl,
      downloadUrl: `${apiUrl}?download=1`,
      apiUrl,
      expiresAt: null,
    }
  }

  const ttl = clampUrlTtl(input.ttlSeconds)
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const keyId = `api-key:${input.apiKeyId ?? ''}`
  const path = (download: boolean) => {
    const query = new URLSearchParams({
      u: userId,
      k: keyId,
      m: 'GET',
      exp: String(expiresAt),
      sig: signObjectUrl('GET', userId, keyId, key, expiresAt),
    })
    if (download) query.set('download', '1')
    return absoluteUrl(req, signedObjectPath(key, query))
  }

  return {
    key,
    previewUrl: path(false),
    downloadUrl: path(true),
    apiUrl,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}

/** The same signature the `/objects/sign` route hands out, for one method. */
export function signedUrl(input: {
  req: Request
  userId: string
  apiKeyId: string
  key: string
  method: SignedMethod
  ttlSeconds?: number
}): { url: string; method: SignedMethod; expiresAt: string } {
  const ttl = clampUrlTtl(input.ttlSeconds)
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const keyId = `api-key:${input.apiKeyId}`
  const query = new URLSearchParams({
    u: input.userId,
    k: keyId,
    m: input.method,
    exp: String(expiresAt),
    sig: signObjectUrl(input.method, input.userId, keyId, input.key, expiresAt),
  })
  return {
    url: absoluteUrl(input.req, signedObjectPath(input.key, query)),
    method: input.method,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}
