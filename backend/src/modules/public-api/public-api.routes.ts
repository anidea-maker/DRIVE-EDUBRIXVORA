import { Router, type NextFunction, type Request, type Response } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireApiKey, SCOPE_HEADER, type ApiKeyRequest } from '../../middleware/api-key.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { streamProviderFile } from '../files/stream-file.js'
import { createFolder, folderCreateSchema, folderSelect } from '../folders/folder.service.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'
import { buildS3ObjectKey, deleteS3Object, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { handleUpload, selectAccount, syncQuotaInBackground } from '../uploads/upload.routes.js'
import { API_SCOPES } from './scopes.js'
import { KIND_FILTERS, absoluteUrl, apiFile, apiFolder, publicBaseUrl } from './serialize.js'

export const publicApiRouter = Router()

const FILE_INCLUDE = {
  folder: { select: { id: true, name: true } },
  connectedAccount: { select: { id: true, provider: true } },
} as const

function queryString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Rewrites `{ file }` / `{ files }` response bodies into the documented API shape,
 * so the multipart upload (which is shared with the dashboard) answers with the
 * same fields - including download URLs - as every other endpoint here.
 */
function withApiFileShape(req: Request, res: Response, next: NextFunction) {
  const json = res.json.bind(res)
  res.json = ((body: unknown) => {
    if (body && typeof body === 'object') {
      const payload = body as Record<string, unknown>
      if (Array.isArray(payload.files)) {
        return json({ ...payload, files: payload.files.map((file) => apiFile(req, file as never)) })
      }
      if (payload.file && typeof payload.file === 'object') {
        return json({ ...payload, file: apiFile(req, payload.file as never) })
      }
    }
    return json(body)
  }) as Response['json']
  next()
}

/* -------------------------------------------------------------------------- */
/*  Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/v1` - a machine-readable index of the API.
 *
 * Someone wiring this into their own site should not need to read this repo to
 * find out which scopes exist or how big an upload may be.
 */
publicApiRouter.get(['/v1', '/v1/'], (req, res) => {
  const base = publicBaseUrl(req)
  res.json({
    service: '9Drive Storage API',
    version: '1',
    baseUrl: `${base}/api/v1`,
    description: 'Store and serve files from 9Drive-connected storage (S3-compatible buckets and Google Drive).',
    auth: {
      type: 'bearer',
      header: 'Authorization: Bearer 9d_live_...',
      queryParam: 'api_key',
      note: 'Keys are created in the dashboard under API Management. They are shown once and stored hashed.',
      scopes: API_SCOPES,
    },
    cors: {
      origins: '*',
      credentials: false,
      note: 'Any origin may call this API with a key. The key is a bearer token, so a browser never sends it automatically.',
    },
    limits: {
      maxUploadBytes: String(env.MAX_UPLOAD_BYTES),
      rateLimitPerMinute: env.API_RATE_LIMIT_PER_MINUTE,
    },
    endpoints: [
      { method: 'GET', path: '/api/v1/me', scope: 'files:read', description: 'Identity, scopes and storage totals.' },
      { method: 'GET', path: '/api/v1/files', scope: 'files:read', description: 'List files. Query: limit, cursor, folderId, root, q, kind, order.' },
      { method: 'POST', path: '/api/v1/files', scope: 'files:write', description: 'Upload one or more files as multipart/form-data.' },
      { method: 'POST', path: '/api/v1/files/raw', scope: 'files:write', description: 'Upload the request body as one file. Query: name, type, folderId.' },
      { method: 'GET', path: '/api/v1/files/:id', scope: 'files:read', description: 'One file and its URLs.' },
      { method: 'GET', path: '/api/v1/files/:id/content', scope: 'files:read', description: 'File bytes (supports Range). Add ?download=1 for an attachment.' },
      { method: 'PATCH', path: '/api/v1/files/:id', scope: 'files:write', description: 'Rename or move a file.' },
      { method: 'DELETE', path: '/api/v1/files/:id', scope: 'files:delete', description: 'Move to trash. Add ?permanent=1 to delete from the provider.' },
      { method: 'POST', path: '/api/v1/files/:id/share', scope: 'files:write', description: 'Mint a public URL that needs no key (for <img src>).' },
      { method: 'DELETE', path: '/api/v1/files/:id/share', scope: 'files:write', description: 'Revoke every public URL for a file.' },
      { method: 'GET', path: '/api/v1/folders', scope: 'files:read', description: 'List folders. Query: parentId, all=1.' },
      { method: 'POST', path: '/api/v1/folders', scope: 'files:write', description: 'Create a folder. Body: name, parentId.' },
      { method: 'GET', path: '/api/v1/usage', scope: 'files:read', description: 'Used and available bytes across every connected account.' },
    ],
  })
})

/* -------------------------------------------------------------------------- */
/*  Authenticated routes                                                       */
/* -------------------------------------------------------------------------- */

const storageRouter = Router()
publicApiRouter.use('/v1', storageRouter)

/** Legacy path from the first API version; kept so existing scripts keep working. */
publicApiRouter.post('/v1/uploads', requireApiKey('files:write'), withApiFileShape, handleUpload)

storageRouter.get('/me', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true } })
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, status: 'connected' },
      select: { id: true, provider: true, email: true, storageAccount: { select: { totalBytes: true, usedBytes: true, availableBytes: true, lastSyncedAt: true } } },
    })

    let usedBytes = 0n
    let totalBytes = 0n
    let unknownCapacity = false
    for (const account of accounts) {
      usedBytes += account.storageAccount?.usedBytes ?? 0n
      if (account.storageAccount?.totalBytes === null || account.storageAccount?.totalBytes === undefined) unknownCapacity = true
      else totalBytes += account.storageAccount.totalBytes
    }

    res.setHeader(SCOPE_HEADER, (req.apiKey?.scopes ?? []).join(','))
    return res.json({
      user,
      key: { id: req.apiKey!.id, scopes: req.apiKey!.scopes },
      accounts: accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        email: account.email,
        usedBytes: account.storageAccount ? account.storageAccount.usedBytes.toString() : '0',
        totalBytes: account.storageAccount?.totalBytes != null ? account.storageAccount.totalBytes.toString() : null,
        lastSyncedAt: account.storageAccount?.lastSyncedAt?.toISOString() ?? null,
      })),
      storage: {
        usedBytes: usedBytes.toString(),
        // null rather than 0: a provider that reports no quota must not look like
        // a full disk, and it must not look like unlimited space either.
        totalBytes: unknownCapacity ? null : totalBytes.toString(),
        note: unknownCapacity ? 'At least one connected account does not report a quota, so totalBytes is null.' : undefined,
      },
    })
  } catch (error) {
    return next(error)
  }
})

storageRouter.get('/usage', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, status: 'connected' },
      select: { id: true, provider: true, storageAccount: { select: { totalBytes: true, usedBytes: true, availableBytes: true } } },
    })
    let usedBytes = 0n
    let totalBytes = 0n
    let reported = true
    for (const account of accounts) {
      usedBytes += account.storageAccount?.usedBytes ?? 0n
      if (account.storageAccount?.totalBytes === null || account.storageAccount?.totalBytes === undefined) reported = false
      else totalBytes += account.storageAccount.totalBytes
    }
    return res.json({
      accounts: accounts.length,
      usedBytes: usedBytes.toString(),
      totalBytes: reported ? totalBytes.toString() : null,
      availableBytes: reported ? (totalBytes > usedBytes ? totalBytes - usedBytes : 0n).toString() : null,
    })
  } catch (error) {
    return next(error)
  }
})

/* ------------------------------- files ----------------------------------- */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  folderId: z.string().optional(),
  root: z.string().optional(),
  q: z.string().trim().max(255).optional(),
  kind: z.string().optional(),
  order: z.enum(['newest', 'oldest', 'name', 'largest']).default('newest'),
  status: z.enum(['active', 'deleted']).default('active'),
})

storageRouter.get('/files', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query)
    const kindTypes = query.kind ? KIND_FILTERS[query.kind.toLowerCase()] : undefined
    if (query.kind && !kindTypes) {
      return res.status(400).json({
        code: 'FILES_UNKNOWN_KIND',
        message: `Unknown kind "${query.kind}".`,
        allowed: Object.keys(KIND_FILTERS),
      })
    }

    const where = {
      userId: req.user!.id,
      status: query.status,
      ...(query.folderId ? { folderId: query.folderId } : {}),
      ...(query.root === '1' || query.root === 'true' ? { folderId: null } : {}),
      ...(query.q ? { name: { contains: query.q } } : {}),
      ...(kindTypes ? { mimeType: { in: kindTypes } } : {}),
    }

    const orderBy = query.order === 'oldest'
      ? { createdAt: 'asc' as const }
      : query.order === 'name'
        ? { name: 'asc' as const }
        : query.order === 'largest'
          ? { sizeBytes: 'desc' as const }
          : { createdAt: 'desc' as const }

    const rows = await prisma.file.findMany({
      where,
      include: FILE_INCLUDE,
      orderBy: [orderBy, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    return res.json({
      files: page.map((file) => apiFile(req, file)),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    })
  } catch (error) {
    return next(error)
  }
})

// Multipart upload: same parser the dashboard uses, so routing, quota selection
// and provider handling cannot behave differently between the two.
storageRouter.post('/files', requireApiKey('files:write'), withApiFileShape, handleUpload)

/**
 * Raw body upload: `curl --data-binary @photo.jpg`.
 *
 * Streamed straight to the provider instead of into memory, so a large file costs
 * the same as a small one. The size comes from Content-Length, because quota
 * routing has to pick an account *before* the bytes are read.
 */
storageRouter.post('/files/raw', requireApiKey('files:write'), async (req: ApiKeyRequest, res, next) => {
  try {
    if (req.body !== undefined && !Buffer.isBuffer(req.body)) {
      return res.status(400).json({
        code: 'UPLOAD_BODY_PARSED_AS_JSON',
        message: 'The request body was read as JSON. Send bytes with a binary content type (image/png, application/octet-stream, ...) or use POST /api/v1/files with multipart/form-data.',
      })
    }

    const declared = Number(req.headers['content-length'] ?? queryString(req.query.sizeBytes) ?? NaN)
    if (!Number.isFinite(declared) || declared <= 0) {
      return res.status(411).json({
        code: 'UPLOAD_SIZE_REQUIRED',
        message: 'Content-Length is required so the upload can be routed to an account with space (or pass ?sizeBytes=).',
      })
    }
    if (declared > env.MAX_UPLOAD_BYTES) {
      return res.status(413).json({ code: 'UPLOAD_TOO_LARGE', message: `Files are limited to ${env.MAX_UPLOAD_BYTES} bytes.` })
    }

    const sizeBytes = BigInt(declared)
    const headerType = (req.header('content-type') ?? '').split(';')[0]!.trim()
    const mimeType = queryString(req.query.type) ?? req.header('x-file-type') ?? (headerType && headerType !== 'application/octet-stream' ? headerType : 'application/octet-stream')
    const name = queryString(req.query.name) ?? req.header('x-file-name') ?? `upload-${Date.now()}${extensionFor(mimeType)}`
    const folderId = queryString(req.query.folderId)

    let targetAccountId: string | undefined
    if (folderId) {
      const folder = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
      if (folder.connectedAccountId) targetAccountId = folder.connectedAccountId
    }

    const account = await selectAccount(req.user!.id, sizeBytes, undefined, targetAccountId)
    if (!account) {
      return res.status(507).json({
        code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE',
        message: 'No connected storage account has this much free space. Connect another bucket in Settings or free up space.',
      })
    }

    const session = await prisma.uploadSession.create({
      data: { userId: req.user!.id, targetConnectedAccountId: account.id, folderId: folderId ?? null, fileName: name, mimeType, sizeBytes, status: 'uploading' },
    })

    if (account.provider === 's3') {
      const config = await getS3ConfigForAccount(account.id, req.user!.id)
      const provisional = await prisma.file.create({
        data: { userId: req.user!.id, connectedAccountId: account.id, folderId: folderId ?? null, provider: 's3', providerFileId: '', name, mimeType, sizeBytes, status: 'uploading' },
      })
      try {
        const key = buildS3ObjectKey(config, req.user!.id, provisional.id, name)
        await uploadS3Object(config, key, req, mimeType)
        const file = await prisma.file.update({ where: { id: provisional.id }, data: { providerFileId: key, status: 'active' }, include: FILE_INCLUDE })
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } }).catch(() => undefined)
        await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: sizeBytes.toString(), source: 'api' })
        res.status(201).json({ file: apiFile(req, file) })
        syncS3Quota(account.id).catch(() => undefined)
        return
      } catch (error) {
        await prisma.file.update({ where: { id: provisional.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: error instanceof Error ? error.message : 'Upload failed' } }).catch(() => undefined)
        return res.status(502).json({
          code: 'UPLOAD_FAILED',
          message: error instanceof Error ? error.message : 'The storage provider refused the upload.',
        })
      }
    }

    try {
      const auth = await getAuthedGoogleClient(account)
      const drive = google.drive({ version: 'v3', auth })
      let parentId = await ensureGoogleAppFolder(account)
      if (folderId) {
        const folder = await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id } })
        if (folder?.providerFolderId) parentId = folder.providerFolderId
      }

      const uploaded = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType, body: req as unknown as NodeJS.ReadableStream },
        fields: 'id,name,mimeType,size',
      })
      const file = await prisma.file.create({
        data: {
          userId: req.user!.id,
          connectedAccountId: account.id,
          folderId: folderId ?? null,
          provider: 'google_drive',
          providerFileId: uploaded.data.id ?? '',
          name: uploaded.data.name ?? name,
          mimeType: uploaded.data.mimeType ?? mimeType,
          sizeBytes,
        },
        include: FILE_INCLUDE,
      })
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } }).catch(() => undefined)
      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: sizeBytes.toString(), source: 'api' })
      res.status(201).json({ file: apiFile(req, file) })
      syncQuotaInBackground(account.id, session.id)
      return
    } catch (error) {
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: error instanceof Error ? error.message : 'Upload failed' } }).catch(() => undefined)
      return res.status(502).json({
        code: 'UPLOAD_FAILED',
        message: error instanceof Error ? error.message : 'Google Drive refused the upload.',
      })
    }
  } catch (error) {
    return next(error)
  }
})

async function findOwnedFile(req: ApiKeyRequest, includeFolder = true) {
  return prisma.file.findFirstOrThrow({
    where: { id: String(req.params.id), userId: req.user!.id },
    include: includeFolder ? { ...FILE_INCLUDE, connectedAccount: true } : { connectedAccount: true },
  })
}

storageRouter.get('/files/:id', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const file = await prisma.file.findFirstOrThrow({ where: { id: String(req.params.id), userId: req.user!.id }, include: FILE_INCLUDE })
    const share = await prisma.fileShare.findFirst({
      where: { fileId: file.id, userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({
      file: apiFile(req, file),
      share: share?.token ? { url: absoluteUrl(req, `/api/public/files/${share.token}/preview`), expiresAt: share.expiresAt?.toISOString() ?? null } : null,
    })
  } catch (error) {
    return next(error)
  }
})

async function streamFile(req: ApiKeyRequest, res: Response, disposition: 'inline' | 'attachment') {
  const file = await findOwnedFile(req)
  if (file.status !== 'active') {
    res.status(410).json({ code: 'FILE_TRASHED', message: 'This file is in the trash. Restore it from the dashboard first.' })
    return
  }
  await streamProviderFile(file, req.headers.range, res, { disposition })
}

storageRouter.get('/files/:id/content', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const wantsDownload = ['1', 'true'].includes(String(req.query.download ?? ''))
    return await streamFile(req, res, wantsDownload ? 'attachment' : 'inline')
  } catch (error) {
    return next(error)
  }
})

storageRouter.get('/files/:id/download', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    return await streamFile(req, res, 'attachment')
  } catch (error) {
    return next(error)
  }
})

storageRouter.patch('/files/:id', requireApiKey('files:write'), async (req: ApiKeyRequest, res, next) => {
  try {
    const body = z.object({ name: z.string().trim().min(1).max(255).optional(), folderId: z.string().nullable().optional() }).parse(req.body)
    const file = await findOwnedFile(req)
    if (body.folderId) await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })

    // S3 objects are keyed by file id, so a rename is metadata only; Google Drive
    // shows the name in the user's own Drive, so it is renamed there too.
    if (body.name && file.provider === 'google_drive') {
      const auth = await getAuthedGoogleClient(file.connectedAccount)
      await google.drive({ version: 'v3', auth }).files.update({ fileId: file.providerFileId, requestBody: { name: body.name } })
    }

    const updated = await prisma.file.update({
      where: { id: file.id },
      data: {
        ...(body.name ? { name: body.name } : {}),
        ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
      },
      include: FILE_INCLUDE,
    })
    await createAuditLog(req.user!.id, 'UPDATE_FILE', 'file', updated.id, { source: 'api', updates: body })
    return res.json({ file: apiFile(req, updated) })
  } catch (error) {
    return next(error)
  }
})

storageRouter.delete('/files/:id', requireApiKey('files:delete'), async (req: ApiKeyRequest, res, next) => {
  try {
    const permanent = ['1', 'true'].includes(String(req.query.permanent ?? ''))
    const file = await findOwnedFile(req)

    if (permanent) {
      try {
        if (file.provider === 's3') await deleteS3Object(file)
        else {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          await google.drive({ version: 'v3', auth }).files.delete({ fileId: file.providerFileId })
        }
      } catch (error) {
        return res.status(502).json({
          code: 'DELETE_FAILED',
          message: error instanceof Error ? error.message : 'The storage provider refused the delete.',
        })
      }
      await prisma.file.delete({ where: { id: file.id } })
      await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, { name: file.name, source: 'api' })
      if (file.connectedAccount.provider === 's3') await syncS3Quota(file.connectedAccountId).catch(() => undefined)
      return res.json({ status: 'ok', permanent: true, id: file.id })
    }

    if (file.status === 'deleted') return res.json({ status: 'ok', permanent: false, id: file.id, alreadyTrashed: true })
    await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } })
    await createAuditLog(req.user!.id, 'TRASH_FILE', 'file', file.id, { name: file.name, source: 'api' })
    return res.json({ status: 'ok', permanent: false, id: file.id })
  } catch (error) {
    return next(error)
  }
})

const shareSchema = z.object({ expiresInSeconds: z.coerce.number().int().min(60).max(31_536_000).optional() })

/**
 * A URL that needs no key.
 *
 * This is the piece that makes 9Drive usable as the storage behind another
 * website: the site's HTML cannot carry an API key, but it can hold
 * `<img src="https://…/api/public/files/<token>/preview">`.
 */
storageRouter.post('/files/:id/share', requireApiKey('files:write'), async (req: ApiKeyRequest, res, next) => {
  try {
    const body = shareSchema.parse(req.body ?? {})
    const file = await findOwnedFile(req)
    if (file.status !== 'active') return res.status(409).json({ code: 'FILE_TRASHED', message: 'Restore the file before sharing it.' })

    const existing = await prisma.fileShare.findFirst({
      where: { fileId: file.id, userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
    })

    let token = existing?.token ?? null
    let expiresAt = existing?.expiresAt ?? null
    if (!existing || !token) {
      token = randomToken(32)
      expiresAt = body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000) : null
      await prisma.fileShare.create({
        data: { fileId: file.id, userId: req.user!.id, token, tokenHash: hashToken(token), expiresAt },
      })
    }

    return res.status(existing ? 200 : 201).json({
      token,
      url: absoluteUrl(req, `/api/public/files/${token}/preview`),
      downloadUrl: absoluteUrl(req, `/api/public/files/${token}/download`),
      pageUrl: `${env.FRONTEND_URL}/public/files/${token}`,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      note: 'No key required. Revoke with DELETE /api/v1/files/:id/share.',
    })
  } catch (error) {
    return next(error)
  }
})

storageRouter.delete('/files/:id/share', requireApiKey('files:write'), async (req: ApiKeyRequest, res, next) => {
  try {
    await prisma.fileShare.updateMany({ where: { fileId: String(req.params.id), userId: req.user!.id, enabled: true }, data: { enabled: false } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

/* ------------------------------- folders --------------------------------- */

storageRouter.get('/folders', requireApiKey('files:read'), async (req: ApiKeyRequest, res, next) => {
  try {
    const query = z.object({ parentId: z.string().optional(), all: z.string().optional() }).parse(req.query)
    const folders = await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null, ...(query.all === '1' ? {} : { parentId: query.parentId ?? null }) },
      select: folderSelect,
      orderBy: { updatedAt: 'desc' },
    })
    return res.json({ folders: folders.map((folder) => ({ ...apiFolder(req, folder), providerFolderId: folder.providerFolderId })) })
  } catch (error) {
    return next(error)
  }
})

storageRouter.post('/folders', requireApiKey('files:write'), async (req: ApiKeyRequest, res, next) => {
  try {
    const body = folderCreateSchema.parse(req.body)
    const folder = await createFolder(req.user!.id, body)
    return res.status(201).json({ folder: { ...apiFolder(req, folder), providerFolderId: folder.providerFolderId } })
  } catch (error) {
    return next(error)
  }
})

/* -------------------------------------------------------------------------- */

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
}

/** A name-less raw upload still needs an extension or downloads lose their type. */
function extensionFor(mimeType: string) {
  return MIME_EXTENSIONS[mimeType] ?? ''
}
