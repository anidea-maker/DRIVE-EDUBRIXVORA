import { Router, type Request, type Response } from 'express'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { streamProviderFile } from '../files/stream-file.js'
import { grantsScope, normalizeScopes } from '../public-api/scopes.js'
import { verifyObjectUrl, type SignatureProblem, type SignedMethod } from '../public-api/object-signing.js'
import { findObject, objectKeyMessage, objectKeyProblem, putObject, type ObjectProblem } from '../public-api/objects.service.js'
import { safeInlineMimeType } from '../public-api/objects.shared.js'
import { safeStorageProblem } from '../public-api/safe-errors.js'

/**
 * `/api/public/objects/<key>` - the destination of a signed object URL.
 *
 * No API key is involved: the signature in the query string *is* the credential,
 * and it is bound to one user, one signing identity, one key, one method and one
 * expiry. The signing identity is verified live against the database, so a revoked or
 * down-scoped API key cannot keep using an old link.
 */
export const objectLinkRouter = Router()

function keyFromParams(params: Record<string, unknown>) {
  return Array.isArray(params.key) ? params.key.join('/') : typeof params.key === 'string' ? params.key : ''
}

function query(req: Request, name: string) {
  const value = req.query[name]
  return typeof value === 'string' && value ? value : undefined
}

function signatureStatus(problem: SignatureProblem) {
  return problem === 'missing' ? 401 : 403
}

function reject(res: Response, problem: SignatureProblem) {
  if (problem === 'missing') {
    return res.status(401).json({
      code: 'SIGNED_URL_REQUIRED',
      message: 'This endpoint only accepts signed links. Mint one with POST /api/v1/objects/sign.',
    })
  }
  if (problem === 'identity') {
    return res.status(403).json({
      code: 'SIGNED_URL_IDENTITY_REQUIRED',
      message: 'This signed link is missing its signing identity. Mint a new link with POST /api/v1/objects/sign.',
    })
  }
  if (problem === 'permission') {
    return res.status(403).json({
      code: 'SIGNED_URL_PERMISSION_REVOKED',
      message: 'The API key or resource that signed this link is no longer authorized. Mint a new link after restoring access.',
    })
  }
  if (problem === 'expired') {
    return res.status(403).json({
      code: 'SIGNED_URL_EXPIRED',
      message: 'This link has expired. Mint a new one with POST /api/v1/objects/sign.',
    })
  }
  return res.status(403).json({
    code: 'SIGNED_URL_INVALID',
    message: 'The signature does not match this identity, key, method and expiry. A link for another object or another method cannot be reused.',
  })
}

/** Verifies the request against the URL it arrived on. Returns a problem, or null. */
function checkSignature(
  req: Request,
  key: string,
  expected: SignedMethod,
): { problem: SignatureProblem | null; keyProblem: ObjectProblem | null; keyId: string | undefined } {
  const keyProblem = objectKeyProblem(key)
  if (keyProblem) return { problem: 'invalid', keyProblem, keyId: undefined }
  // The signature covers the method in the URL, so a GET link cannot be replayed
  // as a PUT: the method sent here must match the method that was signed.
  // Checked only when present - a request with no signature at all should be told
  // it needs one, not that its (absent) signature is wrong.
  const method = query(req, 'm')
  if (method && method !== expected) return { problem: 'invalid', keyProblem: null, keyId: undefined }
  const exp = Number(query(req, 'exp') ?? NaN)
  const keyId = query(req, 'k')
  const problem = verifyObjectUrl({
    method: expected,
    userId: query(req, 'u'),
    keyId,
    key,
    expiresAt: Number.isFinite(exp) ? exp : undefined,
    signature: query(req, 'sig'),
  })
  return { problem, keyProblem: null, keyId }
}

/**
 * A valid HMAC is not enough: the identity that minted it must still be allowed
 * to perform this operation. API-key links are checked against the live key row;
 * resource capability links are checked against the live resource row.
 */
async function checkSignedSubject(
  userId: string | undefined,
  keyId: string | undefined,
  key: string,
  expected: SignedMethod,
): Promise<SignatureProblem | null> {
  if (!userId || !keyId) return 'identity'
  if (keyId.startsWith('api-key:')) {
    const apiKey = await prisma.apiKey.findUnique({
      where: { id: keyId.slice('api-key:'.length) },
      select: { id: true, userId: true, status: true, revokedAt: true, expiresAt: true, scopes: true },
    })
    if (!apiKey || apiKey.userId !== userId) return 'invalid'
    if (apiKey.status !== 'active' || apiKey.revokedAt || (apiKey.expiresAt && apiKey.expiresAt <= new Date())) return 'permission'
    const needed = expected === 'PUT' ? 'files:write' : 'files:read'
    if (!grantsScope(normalizeScopes(apiKey.scopes), needed)) return 'permission'
    return null
  }
  if (keyId.startsWith('resource:')) {
    // Resource capability URLs are read-only, minted only after Edvanta verifies
    // its own user. A PUT link can never use this identity.
    if (expected !== 'GET') return 'invalid'
    const file = await prisma.file.findUnique({
      where: { id: keyId.slice('resource:'.length) },
      select: { id: true, userId: true, objectKey: true, status: true, availability: true, isResource: true },
    })
    if (!file || !file.isResource || file.userId !== userId || file.objectKey !== key || file.status !== 'active') return 'invalid'
    if (file.availability === 'missing') return 'permission'
    return null
  }
  return 'invalid'
}

function uploadFailureStatus(code: string) {
  return safeStorageProblem({ code }, code).status
}

function setPreviewHeaders(res: Response, forceDownload: boolean) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Preview-Mode', forceDownload ? 'download' : 'inline')
  if (!forceDownload) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
}

objectLinkRouter.head('/*key', async (req, res, next) => {
  try {
    const key = keyFromParams(req.params)
    const check = checkSignature(req, key, 'GET')
    if (check.keyProblem) return res.status(400).end()
    if (check.problem) return res.status(signatureStatus(check.problem)).end()
    const permission = await checkSignedSubject(query(req, 'u'), check.keyId, key, 'GET')
    if (permission) return res.status(signatureStatus(permission)).end()

    const file = await findObject(query(req, 'u')!, key)
    if (!file) return res.status(404).end()
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', file.sizeBytes.toString())
    if (file.checksum) res.setHeader('ETag', `"${file.checksum}"`)
    res.setHeader('Last-Modified', file.updatedAt.toUTCString())
    res.setHeader('X-Content-Type-Options', 'nosniff')
    return res.status(200).end()
  } catch (error) {
    return next(error)
  }
})

objectLinkRouter.put('/*key', async (req, res, next) => {
  try {
    const key = keyFromParams(req.params)
    const check = checkSignature(req, key, 'PUT')
    if (check.keyProblem) return res.status(400).json({ code: 'OBJECT_KEY_INVALID', message: objectKeyMessage(check.keyProblem) })
    if (check.problem) return reject(res, check.problem)
    const permission = await checkSignedSubject(query(req, 'u'), check.keyId, key, 'PUT')
    if (permission) return reject(res, permission)

    const length = Number(req.header('content-length') ?? NaN)
    if (!Number.isFinite(length) || length <= 0) {
      return res.status(411).json({ code: 'OBJECT_SIZE_REQUIRED', message: 'Content-Length is required for a signed upload.' })
    }
    if (length > env.MAX_UPLOAD_BYTES) {
      return res.status(413).json({ code: 'OBJECT_TOO_LARGE', message: `Objects are limited to ${env.MAX_UPLOAD_BYTES} bytes.` })
    }

    const result = await putObject({
      userId: query(req, 'u')!,
      key,
      body: req,
      sizeBytes: BigInt(length),
      mimeType: (req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim() || 'application/octet-stream',
      source: 'signed-url',
    })

    if (!result.ok) {
      return res.status(uploadFailureStatus(result.code)).json({
        code: result.code,
        message: result.message ?? safeStorageProblem({ code: result.code }, result.code).message,
      })
    }

    if (result.file.checksum) res.setHeader('ETag', `"${result.file.checksum}"`)
    return res.status(result.created ? 201 : 200).json({
      key,
      name: result.file.name,
      sizeBytes: result.file.sizeBytes.toString(),
      checksum: result.file.checksum,
      created: result.created,
    })
  } catch (error) {
    return next(error)
  }
})

objectLinkRouter.get('/*key', async (req, res, next) => {
  try {
    const key = keyFromParams(req.params)
    const check = checkSignature(req, key, 'GET')
    if (check.keyProblem) return res.status(400).json({ code: 'OBJECT_KEY_INVALID', message: objectKeyMessage(check.keyProblem) })
    if (check.problem) return reject(res, check.problem)
    const permission = await checkSignedSubject(query(req, 'u'), check.keyId, key, 'GET')
    if (permission) return reject(res, permission)

    const file = await findObject(query(req, 'u')!, key)
    if (!file) return res.status(404).json({ code: 'NO_SUCH_KEY', message: `There is no object at "${key}".`, key })

    const forceDownload = ['1', 'true'].includes(query(req, 'download') ?? '') || !safeInlineMimeType(file.mimeType)
    setPreviewHeaders(res, forceDownload)
    return await streamProviderFile(file, req.headers.range, res, {
      disposition: forceDownload ? 'attachment' : 'inline',
    })
  } catch (error) {
    return next(error)
  }
})
