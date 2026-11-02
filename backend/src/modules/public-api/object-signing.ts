import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

/**
 * Signed object URLs.
 *
 * The other website's browser cannot hold an API key, but it does need to stream
 * a file up or down. A signed URL is the S3 answer to that: the server mints one
 * with a short expiry, and the link itself is the credential.
 *
 * The signature covers the user, the signing identity (`api-key:<id>` or
 * `resource:<id>`), the object key, the method and the expiry. The identity is
 * verified against MySQL when the link is used, so revoking/expiring the API key
 * or removing its scope invalidates outstanding links. A capability URL minted
 * for a resource row is checked against that row instead.
 */
export type SignedMethod = 'GET' | 'HEAD' | 'PUT'
export type SignatureProblem = 'missing' | 'identity' | 'permission' | 'expired' | 'invalid'

const PURPOSE = '9drive:object-url:v2'

function secret() {
  // A dedicated secret is optional: deriving one from the encryption key means
  // signed links work on an existing deployment with no new configuration, and
  // rotating TOKEN_ENCRYPTION_KEY invalidates every outstanding link.
  const configured = env.OBJECT_URL_SIGNING_SECRET?.trim()
  if (configured) return configured
  return createHmac('sha256', env.TOKEN_ENCRYPTION_KEY).update(PURPOSE).digest('hex')
}

function payload(method: SignedMethod, userId: string, keyId: string, key: string, expiresAt: number) {
  return `${method}\n${userId}\n${keyId}\n${key}\n${expiresAt}`
}

export function signObjectUrl(method: SignedMethod, userId: string, keyId: string, key: string, expiresAt: number) {
  return createHmac('sha256', secret()).update(payload(method, userId, keyId, key, expiresAt)).digest('base64url')
}

export function verifyObjectUrl(input: {
  method: string
  userId: string | undefined
  keyId: string | undefined
  key: string
  expiresAt: number | undefined
  signature: string | undefined
}): SignatureProblem | null {
  if (!input.userId || !input.expiresAt || !input.signature) return 'missing'
  if (!input.keyId) return 'identity'
  if (!Number.isFinite(input.expiresAt) || input.expiresAt * 1000 <= Date.now()) return 'expired'
  const method = input.method.toUpperCase() as SignedMethod
  // HEAD is a GET without a body, so it shares GET's signature.
  const expected = signObjectUrl(method === 'HEAD' ? 'GET' : method, input.userId, input.keyId, input.key, input.expiresAt)
  const a = Buffer.from(expected)
  const b = Buffer.from(input.signature)
  if (a.length !== b.length) return 'invalid'
  return timingSafeEqual(a, b) ? null : 'invalid'
}

/** The path a signed link points at, before the host is prepended. */
export function signedObjectPath(key: string, query: URLSearchParams) {
  const encoded = key.split('/').map(encodeURIComponent).join('/')
  return `/api/public/objects/${encoded}?${query.toString()}`
}
