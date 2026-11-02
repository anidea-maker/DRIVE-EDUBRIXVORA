import { Router, type Response } from 'express'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { requireApiKey, type ApiKeyRequest } from '../../middleware/api-key.middleware.js'
import { absoluteUrl } from './serialize.js'
import { signObjectUrl, signedObjectPath, type SignedMethod } from './object-signing.js'
import {
  MAX_OBJECT_KEY_LENGTH,
  decodeContinuation,
  deleteObject,
  etagOf,
  findObject,
  listObjects,
  objectKeyMessage,
  objectKeyProblem,
  putObject,
} from './objects.service.js'
import { streamProviderFile } from '../files/stream-file.js'

export const objectsRouter = Router()

/** Express gives a wildcard back as an array of decoded segments. */
export function keyFromParams(params: Record<string, unknown>): string {
  return Array.isArray(params.key) ? params.key.join('/') : typeof params.key === 'string' ? params.key : ''
}

function invalidKey(res: Response, key: string) {
  const problem = objectKeyProblem(key)
  if (!problem) return false
  res.status(400).json({ code: 'OBJECT_KEY_INVALID', message: objectKeyMessage(problem), key })
  return true
}

function declaredSize(req: ApiKeyRequest) {
  const raw = req.headers['content-length'] ?? (typeof req.query.sizeBytes === 'string' ? req.query.sizeBytes : null)
  const value = Number(raw ?? NaN)
  return Number.isFinite(value) && value > 0 ? BigInt(value) : null
}

function mimeFrom(req: ApiKeyRequest) {
  const header = (req.header('content-type') ?? '').split(';')[0]!.trim()
  const query = typeof req.query.type === 'string' ? req.query.type.trim() : ''
  const mime = query || req.header('x-file-type') || header
  return mime && mime !== 'application/octet-stream' ? mime : 'application/octet-stream'
}

/* ------------------------------- listing --------------------------------- */

objectsRouter.get('/', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const query = z
      .object({
        prefix: z.string().max(MAX_OBJECT_KEY_LENGTH).optional(),
        delimiter: z.string().max(8).optional(),
        'max-keys': z.coerce.number().int().min(1).max(1000).optional(),
        maxKeys: z.coerce.number().int().min(1).max(1000).optional(),
        'continuation-token': z.string().max(2048).optional(),
        continuationToken: z.string().max(2048).optional(),
      })
      .parse(req.query)

    const prefix = query.prefix ?? ''
    const continuationToken = query['continuation-token'] ?? query.continuationToken
    const continuation = decodeContinuation(continuationToken)
    if (continuationToken && !continuation) {
      return res.status(400).json({ code: 'OBJECT_TOKEN_INVALID', message: 'continuation-token is not one this API issued. Start the listing again without it.' })
    }

    const result = await listObjects({
      userId: req.user!.id,
      prefix,
      delimiter: query.delimiter ?? null,
      maxKeys: query['max-keys'] ?? query.maxKeys ?? 1000,
      continuation,
    })

    res.setHeader('X-Object-Count', String(result.objects.length))
    if (result.prefixes.length) res.setHeader('X-Common-Prefixes', String(result.prefixes.length))
    return res.json({
      prefix,
      delimiter: query.delimiter ?? null,
      objects: result.objects,
      prefixes: result.prefixes,
      isTruncated: result.isTruncated,
      nextContinuationToken: result.nextContinuationToken,
    })
  } catch (error) {
    return next(error)
  }
})

/* --------------------------------- sign ---------------------------------- */

/**
 * Mints a URL the other website can hand to a browser: `<img src>` for reads,
 * a direct upload for writes. The key never reaches the browser.
 */
objectsRouter.post('/sign', requireApiKey(['files:read', 'files:write']), async (req: ApiKeyRequest, res, next) => {
  try {
    const body = z
      .object({
        key: z.string().min(1).max(MAX_OBJECT_KEY_LENGTH),
        method: z.enum(['GET', 'HEAD', 'PUT']).default('GET'),
        expiresInSeconds: z.coerce.number().int().min(30).max(604_800).default(3600),
      })
      .parse(req.body ?? {})

    if (invalidKey(res, body.key)) return

    // A GET link is a read; a PUT link is a write. Both are limited to the scopes
    // the calling key already holds, so signing cannot widen access.
    const needed = body.method === 'PUT' ? 'files:write' : 'files:read'
    if (!req.apiKey!.scopes.includes(needed) && !(needed === 'files:write' && req.apiKey!.scopes.includes('files:upload'))) {
      return res.status(403).json({
        code: 'API_KEY_SCOPE_MISSING',
        message: `Signing a ${body.method} link needs the "${needed}" scope; this key has [${req.apiKey!.scopes.join(', ')}].`,
      })
    }

    const expiresAt = Math.floor(Date.now() / 1000) + body.expiresInSeconds
    // HEAD is a GET without a body, so it is signed as a GET and works with the
    // same link - otherwise two links would be needed for one resource.
    const method: SignedMethod = body.method === 'HEAD' ? 'GET' : body.method
    const query = new URLSearchParams({
      u: req.user!.id,
      m: method,
      exp: String(expiresAt),
      sig: signObjectUrl(method, req.user!.id, body.key, expiresAt),
    })

    return res.status(201).json({
      key: body.key,
      method,
      url: absoluteUrl(req, signedObjectPath(body.key, query)),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      note: 'The link is the credential. It cannot be reused for another key or method, and it stops working at expiresAt.',
    })
  } catch (error) {
    return next(error)
  }
})

/* --------------------------------- verbs --------------------------------- */

objectsRouter.put('/*key', requireApiKey('files:write'), async (req: ApiKeyRequest, res, next) => {
  try {
    const key = keyFromParams(req.params)
    if (invalidKey(res, key)) return

    const reqLength = req.header('content-length')
    const sizeBytes = declaredSize(req)
    if (!sizeBytes) {
      return res.status(411).json({
        code: 'OBJECT_SIZE_REQUIRED',
        message: 'Content-Length is required so the object can be placed on an account with room (or pass ?sizeBytes=).',
      })
    }
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
      return res.status(413).json({ code: 'OBJECT_TOO_LARGE', message: `Objects are limited to ${env.MAX_UPLOAD_BYTES} bytes.` })
    }
    if (reqLength === '0') {
      return res.status(400).json({ code: 'OBJECT_EMPTY', message: 'The request body is empty. Use DELETE to remove an object.' })
    }

    const result = await putObject({
      userId: req.user!.id,
      key,
      body: req,
      sizeBytes,
      mimeType: mimeFrom(req),
      source: 'api',
    })

    if (!result.ok) {
      const status = result.code === 'NO_ACCOUNT_WITH_ENOUGH_SPACE' ? 507 : 502
      return res.status(status).json({ code: result.code, message: result.message ?? 'No connected storage account has room for this object.' })
    }

    const etag = etagOf(result.file)
    if (etag) res.setHeader('ETag', etag)
    res.setHeader('Location', absoluteUrl(req, `/api/v1/objects/${key.split('/').map(encodeURIComponent).join('/')}`))
    return res.status(result.created ? 201 : 200).json({
      key,
      sizeBytes: result.file.sizeBytes.toString(),
      mimeType: result.file.mimeType,
      etag,
      lastModified: result.file.updatedAt.toISOString(),
      created: result.created,
    })
  } catch (error) {
    return next(error)
  }
})

objectsRouter.head('/*key', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const key = keyFromParams(req.params)
    if (objectKeyProblem(key)) return res.status(400).end()

    const file = await findObject(req.user!.id, key)
    // S3 answers a HEAD for a missing key with no body at all.
    if (!file) return res.status(404).end()

    const etag = etagOf(file)
    if (etag) res.setHeader('ETag', etag)
    res.setHeader('Content-Type', file.mimeType)
    res.setHeader('Content-Length', file.sizeBytes.toString())
    res.setHeader('Last-Modified', file.updatedAt.toUTCString())
    res.setHeader('Accept-Ranges', 'bytes')
    return res.status(200).end()
  } catch (error) {
    return next(error)
  }
})

objectsRouter.delete('/*key', requireApiKey('files:delete'), async (req: ApiKeyRequest, res, next) => {
  try {
    const key = keyFromParams(req.params)
    if (invalidKey(res, key)) return

    const result = await deleteObject(req.user!.id, key)
    if (!result.deleted && result.message) {
      return res.status(502).json({ code: 'DELETE_FAILED', message: result.message })
    }
    // 204 whether or not it existed: DELETE is idempotent, as in S3.
    return res.status(204).end()
  } catch (error) {
    return next(error)
  }
})
objectsRouter.get('/*key', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const key = keyFromParams(req.params)
    if (invalidKey(res, key)) return

    const file = await findObject(req.user!.id, key)
    if (!file) {
      return res.status(404).json({ code: 'NO_SUCH_KEY', message: `There is no object at "${key}".`, key })
    }

    const etag = etagOf(file)
    if (etag) {
      res.setHeader('ETag', etag)
      // A conditional GET is how a browser or CDN revalidates cheaply.
      const ifNoneMatch = req.header('if-none-match')
      if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === '*')) return res.status(304).end()
    }
    res.setHeader('Last-Modified', file.updatedAt.toUTCString())
    return streamProviderFile(file, req.headers.range, res, {
      disposition: ['1', 'true'].includes(String(req.query.download ?? '')) ? 'attachment' : 'inline',
    })
  } catch (error) {
    return next(error)
  }
})

