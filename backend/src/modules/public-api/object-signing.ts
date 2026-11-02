import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../config/env.js'

/**
 * Signed object URLs.
 *
 * The other website's browser cannot hold an API key, but it does need to stream
 * a file up or down. A signed URL is the S3 answer to that: the server mints one
 * with a short expiry, and the link itself is the credential.
 *
 * The signature covers the user, the key, the method and the expiry, so a link
 * minted for `GET assets/logo.png` cannot be replayed as a `PUT`, cannot be
 * pointed at another key, and cannot outlive its window.
 */
export type SignedMethod = 'GET' | 'HEAD' | 'PUT'

const PURPOSE = '9drive:object-url:v1'

function secret() {
  // A dedicated secret is optional: deriving one from the encryption key means
  // signed links work on an existing deployment with no new configuration, and
  // rotating TOKEN_ENCRYPTION_KEY invalidates every outstanding link.
  const configured = env.OBJECT_URL_SIGNING_SECRET?.trim()
  if (configured) return configured
  return createHmac('sha256', env.TOKEN_ENCRYPTION_KEY).update(PURPOSE).digest('hex')
}

function payload(method: SignedMethod, userId: string, key: string, expiresAt: number) {
  return `${method}\n${userId}\n${key}\n${expiresAt}`
}

export function signObjectUrl(method: SignedMethod, userId: string, key: string, expiresAt: number) {
  return createHmac('sha256', secret()).update(payload(method, userId, key, expiresAt)).digest('base64url')
}

export type SignatureProblem = 'missing' | 'expired' | 'invalid'

export function verifyObjectUrl(input: {
  method: string
  userId: string | undefined
  key: string
  expiresAt: number | undefined
  signature: string | undefined
}): SignatureProblem | null {
  if (!input.userId || !input.expiresAt || !input.signature) return 'missing'
  if (!Number.isFinite(input.expiresAt) || input.expiresAt * 1000 <= Date.now()) return 'expired'
  const method = input.method.toUpperCase() as SignedMethod
  // HEAD shares GET's signature: a HEAD is a GET without a body.
  const expected = signObjectUrl(method === 'HEAD' ? 'GET' : method, input.userId, input.key, input.expiresAt)
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
