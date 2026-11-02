import { Router, type Request, type Response } from 'express'
import { env } from '../../config/env.js'
import { streamProviderFile } from '../files/stream-file.js'
import { verifyObjectUrl, type SignatureProblem, type SignedMethod } from '../public-api/object-signing.js'
import { findObject, objectKeyMessage, objectKeyProblem, putObject, type ObjectProblem } from '../public-api/objects.service.js'

/**
 * `/api/public/objects/<key>` - the destination of a signed object URL.
 *
 * No API key is involved: the signature in the query string *is* the credential,
 * and it is bound to one key, one method and one expiry. That is what lets the
 * other website's browser upload a file or render an image without ever holding
 * the secret.
 */
export const objectLinkRouter = Router()

function keyFromParams(params: Record<string, unknown>) {
  return Array.isArray(params.key) ? params.key.join('/') : typeof params.key === 'string' ? params.key : ''
}

function query(req: Request, name: string) {
  const value = req.query[name]
  return typeof value === 'string' && value ? value : undefined
}

function reject(res: Response, problem: SignatureProblem) {
  if (problem === 'missing') {
    return res.status(401).json({
      code: 'SIGNED_URL_REQUIRED',
      message: 'This endpoint only accepts signed links. Mint one with POST /api/v1/objects/sign.',
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
    message: 'The signature does not match this key, method and expiry. A link for another object or another method cannot be reused.',
  })
}

/** Verifies the request against the URL it arrived on. Returns a problem, or null. */
function checkSignature(
  req: Request,
  key: string,
  expected: SignedMethod,
): { problem: SignatureProblem | null; keyProblem: ObjectProblem | null } {
  const keyProblem = objectKeyProblem(key)
  if (keyProblem) return { problem: 'invalid', keyProblem }
  // The signature covers the method in the URL, so a GET link cannot be replayed
  // as a PUT: the method sent here must match the method that was signed.
  // Checked only when present - a request with no signature at all should be told
  // it needs one, not that its (absent) signature is wrong.
  const method = query(req, 'm')
  if (method && method !== expected) return { problem: 'invalid', keyProblem: null }
  const exp = Number(query(req, 'exp') ?? NaN)
  const problem = verifyObjectUrl({
    method: expected,
    userId: query(req, 'u'),
    key,
    expiresAt: Number.isFinite(exp) ? exp : undefined,
    signature: query(req, 'sig'),
  })
  return { problem, keyProblem: null }
}

objectLinkRouter.head('/*key', async (req, res, next) => {
  try {
    const key = keyFromParams(req.params)
    const check = checkSignature(req, key, 'GET')
    if (check.keyProblem || check.problem) return res.status(check.problem ? 403 : 400).end()

    const file = await findObject(query(req, 'u')!, key)
    if (!file) return res.status(404).end()
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', file.sizeBytes.toString())
    if (file.checksum) res.setHeader('ETag', `"${file.checksum}"`)
    res.setHeader('Last-Modified', file.updatedAt.toUTCString())
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
      const status = result.code === 'NO_ACCOUNT_WITH_ENOUGH_SPACE' ? 507 : 502
      return res.status(status).json({ code: result.code, message: result.message ?? 'No connected storage account has room for this object.' })
    }

    if (result.file.checksum) res.setHeader('ETag', `"${result.file.checksum}"`)
    return res.status(result.created ? 201 : 200).json({ key, sizeBytes: result.file.sizeBytes.toString(), created: result.created })
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

    const file = await findObject(query(req, 'u')!, key)
    if (!file) return res.status(404).json({ code: 'NO_SUCH_KEY', message: `There is no object at "${key}".`, key })

    return streamProviderFile(file, req.headers.range, res, {
      disposition: ['1', 'true'].includes(query(req, 'download') ?? '') ? 'attachment' : 'inline',
    })
  } catch (error) {
    return next(error)
  }
})

