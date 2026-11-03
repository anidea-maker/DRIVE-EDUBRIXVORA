import Busboy from 'busboy'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { Readable } from 'stream'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { google } from 'googleapis'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { jsonStringArray } from '../../utils/json-column.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireRole } from '../../middleware/role.middleware.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { deleteProviderFile, verifyProviderFile, type ProviderFileRef } from '../storage/provider-operations.js'
import { hashingStream } from '../public-api/objects.shared.js'
import { createAuditLog } from '../../utils/audit.js'
import { buildUniqueObjectKey } from '../public-api/objects.shared.js'

export const uploadRouter = Router()

// Dashboard uploads are an administrator operation. The server reads the role
// from the database; a `student`/`visitor` role or a role claim in a request
// body can never grant upload permission. The public API adds its own role
// check after API-key authentication because it calls handleUpload directly.
uploadRouter.use(requireAuth)
uploadRouter.use(requireRole('manage_resources'))

type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string }
type RoutingMode = 'most_available' | 'round_robin' | 'priority'

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

export function syncQuotaInBackground(accountId: string, sessionId: string) {
  logUpload('quota sync started', { accountId, sessionId })
  syncGoogleQuota(accountId)
    .then(() => logUpload('quota sync completed', { accountId, sessionId }))
    .catch((error) => logUpload('quota sync failed', { accountId, sessionId, message: error instanceof Error ? error.message : 'Unknown error' }))
}

function normalizePriorityAccountIds(value: unknown) {
  return jsonStringArray(value)
}

function byPriority<T extends { account: { id: string; createdAt: Date } }>(items: T[], priorityAccountIds: string[]) {
  const order = new Map(priorityAccountIds.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.account.id)
    const bOrder = order.get(b.account.id)
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1
    return a.account.createdAt.getTime() - b.account.createdAt.getTime()
  })
}

/**
 * `provider` is an optional explicit storage choice (used by the Edvanta
 * resource API). Without it the dashboard's routing policy picks from all
 * connected providers, preserving existing behaviour.
 */
export async function selectAccount(
  userId: string,
  sizeBytes: bigint,
  reservedBytesByAccount = new Map<string, bigint>(),
  targetAccountId?: string | null,
  provider?: string | null,
) {
  const providerFilter = provider ? { provider } : { provider: { in: ['google_drive', 's3'] } }
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, status: 'connected', ...providerFilter, ...(targetAccountId ? { id: targetAccountId } : {}) },
    include: { storageAccount: true },
  })

  const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  await Promise.allSettled(stale.map(async (account) => {
    try {
      if (account.provider === 's3') {
        await syncS3Quota(account.id)
      } else {
        await syncGoogleQuota(account.id)
      }
    } catch (err: any) {
      // Log only the account id and a stable code. Provider messages can contain
      // bucket names, endpoints and account emails, none of which the external
      // website (or a shared log) should see.
      console.error(`[upload] quota sync failed for account ${account.id}: QUOTA_SYNC_FAILED`)
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { lastError: 'Quota sync failed' }
      }).catch(() => undefined)
    }
  }))

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, status: 'connected', ...providerFilter },
    include: { storageAccount: true },
  })

  const eligible = fresh
    .map((account) => ({ account, availableBytes: account.storageAccount?.availableBytes === null || account.storageAccount?.availableBytes === undefined ? null : account.storageAccount.availableBytes - (reservedBytesByAccount.get(account.id) ?? 0n) }))
    .filter(({ availableBytes }) => availableBytes === null || availableBytes >= sizeBytes)

  if (eligible.length === 0) return null

  if (targetAccountId) {
    const target = eligible.find(e => e.account.id === targetAccountId)
    return target?.account ?? null
  }

  const policy = await prisma.uploadRoutingPolicy.upsert({ where: { userId }, create: { userId, mode: 'most_available', priorityAccountIds: '[]' }, update: {} })
  const mode = (['most_available', 'round_robin', 'priority'].includes(policy.mode) ? policy.mode : 'most_available') as RoutingMode
  const priorityAccountIds = normalizePriorityAccountIds(policy.priorityAccountIds)

  if (mode === 'priority') return byPriority(eligible, priorityAccountIds)[0]?.account ?? null

  if (mode === 'round_robin') {
    const ordered = byPriority(eligible, priorityAccountIds)
    const selected = ordered[policy.roundRobinCursor % ordered.length]?.account ?? ordered[0]?.account ?? null
    await prisma.uploadRoutingPolicy.update({ where: { userId }, data: { roundRobinCursor: policy.roundRobinCursor + 1 } })
    return selected
  }

  return eligible
    .sort((a, b) => {
      if (a.availableBytes === null && b.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (a.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (b.availableBytes === null) return b.account.provider === 's3' ? 1 : -1
      return Number(b.availableBytes - a.availableBytes)
    })[0]?.account
}

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let responded = false
    let fileSeen = false
    const reservedBytesByAccount = new Map<string, bigint>()
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string }> = []
    const pendingUploads: Array<Promise<void>> = []

    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      return res.status(status).json({ code, message })
    }

    const parseBatchMeta = (value: string) => JSON.parse(value).map((item: { fieldName: string; fileName: string; mimeType: string; sizeBytes: string | number; folderId?: string }) => ({
      fieldName: item.fieldName,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: BigInt(item.sizeBytes),
      folderId: item.folderId,
    })) as UploadMeta[]

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }) => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId }
    }

    const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const meta = metaForFile(fieldName, info)
      const fileName = meta?.fileName || info.filename
      let sessionId: string | null = null
      let s3FileId: string | null = null
      let providerRef: ProviderFileRef | null = null
      let truncated = false
      try {
        fileStream.on('limit', () => {
          truncated = true
          logUpload('file stream size limit reached', { fileName })
        })
        if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
          return
        }
        if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }

        const folderId = meta.folderId || null
        let targetAccountId: string | undefined = undefined
        if (folderId) {
          const folderRecord = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
          if (folderRecord.connectedAccountId) targetAccountId = folderRecord.connectedAccountId
        }

        const account = await selectAccount(req.user!.id, meta.sizeBytes, reservedBytesByAccount, targetAccountId)
        if (!account) {
          fileStream.resume()
          failed.push({ fileName, code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space for this upload.' })
          return
        }
        reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes)

        const session = await prisma.uploadSession.create({ data: { userId: req.user!.id, targetConnectedAccountId: account.id, folderId, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
        sessionId = session.id
        logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })

        // Stream straight from Busboy into the provider. A Transform counts and
        // hashes bytes on the way; nothing is buffered in application memory,
        // so a 5 GB upload does not need 5 GB of RAM.
        const hashing = hashingStream()
        fileStream.on('error', (streamError) => hashing.stream.destroy(streamError))
        fileStream.pipe(hashing.stream)

        let providerFileId = ''
        let uploadedName = fileName
        let uploadedMimeType = meta.mimeType
        if (account.provider === 's3') {
          const config = await getS3ConfigForAccount(account.id, req.user!.id)
          /**
           * Dashboard and API uploads address a file by id, but a complete
           * storage backend also lets the caller preview it in a browser. Giving
           * the row a key at creation time is what makes that possible: the
           * listing can then mint a signed URL for it exactly like an object
           * written through `PUT /objects/<key>`. The key is derived from the
           * row id, so it is stable and cannot collide with the uploaded name.
           */
          const provisionalFile = await prisma.file.create({
            data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' },
          })
          const objectKey = buildUniqueObjectKey('uploads', fileName, provisionalFile.id)
          await prisma.file.update({ where: { id: provisionalFile.id }, data: { objectKey } }).catch(() => undefined)
          s3FileId = provisionalFile.id
          // A unique key per attempt keeps any previous object readable.
          providerFileId = buildS3ObjectKey(config, req.user!.id, `${provisionalFile.id}-${randomUUID()}`, fileName)
          providerRef = { provider: 's3', providerFileId, connectedAccountId: account.id, userId: req.user!.id, name: fileName, mimeType: meta.mimeType }
          await uploadS3Object(config, providerFileId, hashing.stream, meta.mimeType)
        } else {
          const auth = await getAuthedGoogleClient(account)
          const drive = google.drive({ version: 'v3', auth })
          const appFolderId = await ensureGoogleAppFolder(account)
          let targetParentId = appFolderId
          if (folderId) {
            const folderRecord = await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id } })
            if (folderRecord?.providerFolderId) targetParentId = folderRecord.providerFolderId
          }
          const uploaded = await drive.files.create({
            requestBody: { name: fileName, parents: [targetParentId] },
            media: { mimeType: meta.mimeType, body: hashing.stream },
            fields: 'id,name,mimeType,size',
            supportsAllDrives: true,
          })
          providerFileId = uploaded.data.id ?? ''
          uploadedName = uploaded.data.name ?? fileName
          uploadedMimeType = uploaded.data.mimeType ?? meta.mimeType
          providerRef = { provider: 'google_drive', providerFileId, connectedAccountId: account.id, userId: req.user!.id, name: uploadedName, mimeType: uploadedMimeType }
        }

        const { bytes } = hashing.result()
        if (truncated || BigInt(bytes) !== meta.sizeBytes || !providerFileId) {
          throw new Error(`UPLOAD_SIZE_MISMATCH: received ${bytes} bytes, expected ${meta.sizeBytes.toString()}.`)
        }
        // Never report success until the provider confirms the object exists.
        const verification = await verifyProviderFile({ ...providerRef!, sizeBytes: meta.sizeBytes })
        if (verification.availability !== 'available') {
          throw new Error(`UPLOAD_VERIFICATION_FAILED: ${verification.detail ?? 'the provider did not confirm the object'}`)
        }

        const finalSize = verification.sizeBytes ?? meta.sizeBytes
        if (account.provider === 's3' && s3FileId) {
          const file = await prisma.file.update({ where: { id: s3FileId }, data: { providerFileId, sizeBytes: finalSize, status: 'active' } })
          completed.push({ ...file, sizeBytes: file.sizeBytes.toString() })
        } else {
          const file = await prisma.file.create({
            data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 'google_drive', providerFileId, name: uploadedName, mimeType: uploadedMimeType, sizeBytes: finalSize, status: 'active', availability: 'available', lastVerifiedAt: new Date(), uploadedBy: req.user!.id },
          })
          // Same reason as the S3 branch: a key is what a browser preview needs.
          const objectKey = buildUniqueObjectKey('uploads', uploadedName, file.id)
          const withKey = await prisma.file.update({ where: { id: file.id }, data: { objectKey } }).catch(() => file)
          completed.push({ ...withKey, sizeBytes: withKey.sizeBytes.toString() })
        }
        logUpload('upload verified and registered', { sessionId: session.id, provider: account.provider, fileId: providerFileId })
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
        if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
        else syncQuotaInBackground(account.id, session.id)
        // Provider bytes are now the live version; no cleanup on success.
        providerRef = null
      } catch (error) {
        // A partially uploaded object must not become an orphan or a "successful"
        // dashboard file. Files are never made public: previews use authenticated
        // streaming or short-lived share tokens instead.
        if (providerRef) await deleteProviderFile(providerRef).catch((cleanupError) => logUpload('upload cleanup failed', { fileName, message: cleanupError instanceof Error ? cleanupError.message : 'unknown' }))
        if (s3FileId) await prisma.file.update({ where: { id: s3FileId }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
        if (sessionId) await prisma.uploadSession.update({ where: { id: sessionId }, data: { status: 'failed', errorMessage: error instanceof Error ? error.message : 'Upload failed' } }).catch(() => undefined)
        fileStream.unpipe?.()
        fileStream.resume()
        logUpload('file upload failed', { fileName, message: error instanceof Error ? error.message : 'Upload failed' })
        failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
      }
    }

    busboy.on('field', (name, value) => {
      if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
      if (name === 'fileName') fields.fileName = value
      if (name === 'mimeType') fields.mimeType = value
      if (name === 'folderId') fields.folderId = value
      if (name === 'filesMeta') batchMeta = parseBatchMeta(value)
    })

    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      pendingUploads.push(uploadOne(name, fileStream, info))
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      Promise.all(pendingUploads).then(() => {
        if (responded) return
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed })
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
}

uploadRouter.post('/', requireAuth, handleUpload)

// Resumable upload endpoints

// 1. Initialize resumable session
uploadRouter.post('/resumable/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.string(),
      folderId: z.string().nullable().optional(),
      targetAccountId: z.string().nullable().optional()
    }).parse(req.body)

    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })

    const folderId = body.folderId || null
    let targetAccountId = body.targetAccountId
    if (folderId) {
      const folderRecord = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
      if (folderRecord.connectedAccountId) {
        targetAccountId = folderRecord.connectedAccountId
      }
    }

    const account = await selectAccount(req.user!.id, sizeBytes, undefined, targetAccountId)
    if (!account) return res.status(400).json({ code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space.' })

    if (account.provider !== 'google_drive') {
      const session = await prisma.uploadSession.create({
        data: {
          userId: req.user!.id,
          targetConnectedAccountId: account.id,
          folderId,
          fileName: body.fileName,
          mimeType: body.mimeType,
          sizeBytes,
          status: 'uploading'
        }
      })
      return res.status(201).json({ sessionId: session.id, provider: account.provider, offset: 0 })
    }

    const auth = await getAuthedGoogleClient(account)
    const appFolderId = await ensureGoogleAppFolder(account)
    let targetParentId = appFolderId
    if (folderId) {
      const folderRecord = await prisma.folder.findFirst({ where: { id: folderId, userId: req.user!.id } })
      if (folderRecord?.providerFolderId) {
        targetParentId = folderRecord.providerFolderId
      }
    }

    // Initiate Google Drive Resumable Session
    const headers = new Headers()
    const token = await auth.getAccessToken()
    headers.set('Authorization', `Bearer ${token.token}`)
    headers.set('Content-Type', 'application/json')
    headers.set('X-Upload-Content-Type', body.mimeType)
    headers.set('X-Upload-Content-Length', sizeBytes.toString())

    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: body.fileName,
        parents: [targetParentId]
      })
    })

    if (!initRes.ok) {
      const errText = await initRes.text()
      throw new Error(`Google API Init Error: ${errText}`)
    }

    const sessionUri = initRes.headers.get('location')
    if (!sessionUri) throw new Error('Google API did not return Location header.')

    const session = await prisma.uploadSession.create({
      data: {
        userId: req.user!.id,
        targetConnectedAccountId: account.id,
        folderId,
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes,
        status: 'uploading',
        googleSessionUri: sessionUri
      }
    })

    return res.status(201).json({ sessionId: session.id, provider: 'google_drive', offset: 0 })
  } catch (error) {
    return next(error)
  }
})

// 2. Query/Resume resumable status
uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    if (session.status === 'completed') {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    if (!session.googleSessionUri || !session.targetConnectedAccountId) {
      return res.json({ status: 'uploading', offset: '0' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })
    const auth = await getAuthedGoogleClient(account)
    const token = await auth.getAccessToken()

    // Query Google Drive for uploaded offset
    const queryHeaders = new Headers()
    queryHeaders.set('Authorization', `Bearer ${token.token}`)
    queryHeaders.set('Content-Range', `bytes */${session.sizeBytes}`)

    const queryRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: queryHeaders
    })

    if (queryRes.status === 308) {
      const range = queryRes.headers.get('range')
      if (range) {
        // e.g. bytes=0-1048575
        const parts = range.split('-')
        const lastByte = BigInt(parts[1])
        return res.json({ status: 'uploading', offset: (lastByte + 1n).toString() })
      }
    } else if (queryRes.ok) {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    return res.json({ status: 'uploading', offset: '0' })
  } catch (error) {
    return res.json({ status: 'failed', offset: '0' })
  }
})

// 3. Upload chunk
uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    const rangeHeader = req.headers['content-range']
    if (!rangeHeader || typeof rangeHeader !== 'string') {
      return res.status(400).json({ code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' })
    }

    // Parse Content-Range, e.g. bytes 0-5242879/10485760
    const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/)
    if (!match) return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' })

    const startByte = BigInt(match[1])
    const endByte = BigInt(match[2])
    const totalBytes = BigInt(match[3])

    if (!session.googleSessionUri || !session.targetConnectedAccountId) {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Only Google Drive resumable uploads supported.' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const token = await auth.getAccessToken()

    // Stream chunk body from client to Google Drive resumable URI
    const putHeaders = new Headers()
    putHeaders.set('Authorization', `Bearer ${token.token}`)
    putHeaders.set('Content-Range', rangeHeader)
    putHeaders.set('Content-Length', (endByte - startByte + 1n).toString())

    const putRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: putHeaders,
      body: req as any,
      duplex: 'half'
    } as any)

    if (putRes.status === 308) {
      return res.json({ status: 'uploading', offset: (endByte + 1n).toString() })
    }

    if (putRes.ok) {
      // Completed! Parse metadata
      const fileMeta = await putRes.json() as { id: string; name: string; mimeType: string }

      // The Drive file intentionally stays private. Preview/download go through
      // this backend with an authenticated session or an expiring share token.
      let existingFile = await prisma.file.findFirst({
        where: { providerFileId: fileMeta.id, userId: req.user!.id }
      })

      if (!existingFile) {
        existingFile = await prisma.file.create({
          data: {
            userId: req.user!.id,
            connectedAccountId: account.id,
            folderId: session.folderId,
            provider: 'google_drive',
            providerFileId: fileMeta.id,
            name: fileMeta.name || session.fileName,
            mimeType: fileMeta.mimeType || session.mimeType,
            sizeBytes: totalBytes,
            availability: 'available',
            lastVerifiedAt: new Date(),
            uploadedBy: req.user!.id
          }
        })
      }

      await prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: 'completed', completedAt: new Date() }
      })

      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', existingFile.id, { name: existingFile.name, size: existingFile.sizeBytes.toString() })

      syncQuotaInBackground(account.id, session.id)

      return res.status(201).json({ status: 'completed', file: { ...existingFile, sizeBytes: existingFile.sizeBytes.toString() } })
    }

    const errorMsg = await putRes.text()
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: errorMsg }
    })

    return res.status(putRes.status).json({ code: 'UPLOAD_FAILED', message: errorMsg })
  } catch (error) {
    return next(error)
  }
})
