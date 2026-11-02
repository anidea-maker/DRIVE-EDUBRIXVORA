import type { Request } from 'express'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { signObjectUrl, signedObjectPath } from '../public-api/object-signing.js'
import { absoluteUrl } from '../public-api/serialize.js'

export type MintedUrl = {
  url: string
  expiresAt: string
  mechanism: 'signed-object-url' | 'short-lived-share-token'
  /** The API key never reaches the browser; this link is the only credential. */
  note: string
}

/**
 * A short-lived capability URL for a preview or download.
 *
 * Edvanta's server authenticates its own student/admin session first, then asks
 * for this URL. The browser receives no API key and no cloud credential. For
 * resource rows written through the object API we use the existing HMAC-signed
 * object URL (bound to one user, one key, GET and an expiry). For older rows
 * without an object key we mint a hashed, expiring FileShare token. Neither
 * makes a Drive file or an S3 bucket public.
 */
export async function mintResourceUrl(
  req: Request,
  file: { id: string; userId: string; objectKey: string | null },
  options: { download?: boolean; ttlSeconds?: number } = {},
): Promise<MintedUrl> {
  const requested = Number(options.ttlSeconds ?? env.RESOURCE_URL_TTL_SECONDS)
  const ttl = Math.max(30, Math.min(Number.isFinite(requested) ? Math.trunc(requested) : env.RESOURCE_URL_TTL_SECONDS, 3600))
  const expiresAt = new Date(Date.now() + ttl * 1000)
  const download = Boolean(options.download)

  if (file.objectKey) {
    const epoch = Math.floor(expiresAt.getTime() / 1000)
    // A resource capability is bound to the stable row, not to an API key. The
    // public-link handler checks that this row still exists, is active and still
    // owns the object key before streaming anything.
    const keyId = `resource:${file.id}`
    const query = new URLSearchParams({
      u: file.userId,
      k: keyId,
      m: 'GET',
      exp: String(epoch),
      sig: signObjectUrl('GET', file.userId, keyId, file.objectKey, epoch),
      ...(download ? { download: '1' } : {}),
    })
    return {
      url: absoluteUrl(req, signedObjectPath(file.objectKey, query)),
      expiresAt: expiresAt.toISOString(),
      mechanism: 'signed-object-url',
      note: 'Bound to this resource row, its object key and GET method; expires at expiresAt. Mint it only after verifying the end user on Edvanta.',
    }
  }

  const token = randomToken(32)
  await prisma.fileShare.create({
    data: { fileId: file.id, userId: file.userId, token, tokenHash: hashToken(token), expiresAt },
  })
  const path = download ? `/api/public/files/${token}/download` : `/api/public/files/${token}/preview`
  return {
    url: absoluteUrl(req, path),
    expiresAt: expiresAt.toISOString(),
    mechanism: 'short-lived-share-token',
    note: 'Stored hashed, expires at expiresAt, and can be revoked with DELETE /api/v1/files/:id/share.',
  }
}
