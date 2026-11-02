import Busboy from 'busboy'
import { Prisma, type File as PrismaFile } from '@prisma/client'
import { Router, type NextFunction, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { ZipArchive } from 'archiver'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireApiKey, type ApiKeyRequest } from '../../middleware/api-key.middleware.js'
import { requireRole } from '../../middleware/role.middleware.js'
import { canManageResources, effectiveRole, isActive } from '../auth/roles.js'
import { createAuditLog } from '../../utils/audit.js'
import { putObject } from '../public-api/objects.service.js'
import { publicBaseUrl } from '../public-api/serialize.js'
import { getStorageAdapter } from '../storage/adapters.js'
import { buildStorageReport } from '../storage/storage-status.js'
import { ProviderOperationError } from '../storage/provider-operations.js'
import { mintResourceUrl } from './resource-urls.js'
import {
  buildStorageStatus,
  checkBulkLimits,
  createResourceRecord,
  decodeResourceCursor,
  emptyResourceCounts,
  encodeResourceCursor,
  normalizeCountGroups,
  parseResourceUploadMeta,
  previewFor,
  resourceCountsCacheKey,
  resourceCountsWhere,
  resolveZipNames,
  resourcePatchSchema,
  resourceUploadSchema,
  safeResourceFileName,
  serializeResource,
  syncResourceBatch,
  VISIBILITIES,
  type ResourceCounts,
  type ResourceRow,
  type ResourceUploadMeta,
} from './resource.service.js'

/**
 * `/api/v1/resources` - the authenticated contract between Edvanta (main
 * educational website) and EduBrixVora (storage application).
 *
 * Edvanta's *server* holds the API key and must authenticate its own student or
 * administrator before calling these routes. Browsers never receive the key;
 * they receive short-lived capability URLs for preview/download. Every path
 * enforces an API-key scope, and every write path also verifies the key owner's
 * role in the database. A role sent by a browser is never trusted.
 */
export const resourceRouter = Router()

class ResourceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ResourceHttpError'
  }
}

type Handler = (req: ApiKeyRequest, res: Response) => Promise<unknown> | unknown

/** Converts typed failures into safe JSON, and forwards unexpected errors. */
function route(handler: Handler) {
  return (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      if (res.headersSent) return
      if (error instanceof ResourceHttpError) {
        return res.status(error.status).json({ code: error.code, message: error.message, ...error.extra })
      }
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          code: 'RESOURCE_VALIDATION_FAILED',
          message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
          issues: error.issues,
        })
      }
      return next(error)
    })
  }
}

function noStore(res: Response) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
}

function baseUrl(req: ApiKeyRequest) {
  return publicBaseUrl(req)
}

/** Adds the S3 bucket name (never a credential) to the registry row. */
async function toResourceRow(file: PrismaFile): Promise<ResourceRow> {
  let bucketName: string | null = null
  if (file.provider === 's3') {
    const config = await prisma.s3StorageConfig.findFirst({
      where: { connectedAccountId: file.connectedAccountId, status: 'active' },
      select: { bucket: true, endpoint: true },
    })
    if (config) {
      bucketName = config.endpoint?.toLowerCase().includes('backblazeb2.com')
        ? config.bucket.toLowerCase()
        : config.bucket
    }
  }
  return {
    ...file,
    bucketName,
    resourceMetadata: file.resourceMetadata ?? null,
  } as unknown as ResourceRow
}

function providerRef(file: ResourceRow | PrismaFile, userId: string) {
  return {
    provider: file.provider,
    providerFileId: file.providerFileId,
    connectedAccountId: file.connectedAccountId,
    userId,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }
}

async function assertAdminAudience(req: ApiKeyRequest, res: Response, audience: string) {
  if (audience !== 'admin') return true
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, email: true, role: true, status: true },
  })
  if (!user || !isActive(user) || !canManageResources(effectiveRole(user))) {
    res.status(403).json({
      code: 'ROLE_FORBIDDEN',
      message: 'audience=admin requires an administrator account behind this API key.',
    })
    return false
  }
  return true
}

async function findResource(req: ApiKeyRequest, id: string, audience = 'student') {
  const row = await prisma.file.findFirst({ where: { id, userId: req.user!.id, isResource: true } })
  if (!row) throw new ResourceHttpError(404, 'RESOURCE_NOT_FOUND', 'That educational resource does not exist.')
  if (audience !== 'admin' && row.visibility === 'private') {
    throw new ResourceHttpError(403, 'RESOURCE_PRIVATE', 'This resource is private. Edvanta must verify the end user before requesting administrator access.')
  }
  return row
}

function availabilityProblem(row: PrismaFile) {
  if (row.status !== 'active') return new ResourceHttpError(409, 'RESOURCE_TRASHED', 'This resource has been removed.')
  if (row.availability === 'missing') return new ResourceHttpError(410, 'RESOURCE_MISSING', 'The metadata exists but the stored file is missing at the provider.')
  if (row.availability === 'inaccessible') return new ResourceHttpError(502, 'RESOURCE_INACCESSIBLE', 'The storage provider denied access to this file. Reconnect the account or check permissions.')
  return null
}

function uploadStatus(code: string) {
  if (code === 'NO_ACCOUNT_WITH_ENOUGH_SPACE') return 507
  if (code === 'UPLOAD_TOO_LARGE') return 413
  if (code === 'RESOURCE_KEY_INVALID' || code === 'RESOURCE_META_INVALID') return 400
  if (code === 'RESOURCE_IDEMPOTENCY_CONFLICT' || code === 'RESOURCE_IN_PROGRESS') return 409
  return 502
}

/* ------------------------------- pagination ------------------------------ */

type ListOrder = 'newest' | 'oldest' | 'name'

function orderBy(order: ListOrder): Prisma.FileOrderByWithRelationInput[] {
  if (order === 'name') return [{ name: 'asc' }, { id: 'asc' }]
  if (order === 'oldest') return [{ createdAt: 'asc' }, { id: 'asc' }]
  return [{ createdAt: 'desc' }, { id: 'desc' }]
}

async function fetchPage(
  where: Prisma.FileWhereInput,
  order: ListOrder,
  cursorToken: string | undefined,
  limit: number,
  extraFilters: Prisma.FileWhereInput[] = [],
) {
  const cursor = decodeResourceCursor(cursorToken)
  if (cursorToken && !cursor) throw new ResourceHttpError(400, 'RESOURCE_CURSOR_INVALID', 'cursor is not one this API issued. Start the listing again without it.')
  if (cursor && cursor.order !== order) throw new ResourceHttpError(400, 'RESOURCE_CURSOR_ORDER', 'cursor was issued for a different sort order.')

  const filters = [...extraFilters]
  if (cursor) {
    const date = new Date(cursor.createdAt)
    if (order === 'newest') filters.push({ OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: cursor.id } }] })
    else if (order === 'oldest') filters.push({ OR: [{ createdAt: { gt: date } }, { createdAt: date, id: { gt: cursor.id } }] })
    else filters.push({ OR: [{ name: { gt: cursor.name! } }, { name: cursor.name!, id: { gt: cursor.id } }] })
  }

  const existingAnd = where.AND
  const combined: Prisma.FileWhereInput = filters.length
    ? { ...where, AND: [...(Array.isArray(existingAnd) ? existingAnd : existingAnd ? [existingAnd] : []), ...filters] }
    : where

  const rows = await prisma.file.findMany({ where: combined, orderBy: orderBy(order), take: limit + 1 })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = hasMore && last
    ? encodeResourceCursor({ createdAt: last.createdAt.toISOString(), id: last.id, name: last.name, order })
    : null
  return { rows: await Promise.all(page.map(toResourceRow)), hasMore, nextCursor }
}

/* --------------------------------- listing -------------------------------- */

const listQuerySchema = z.object({
  q: z.string().trim().max(255).optional(),
  category: z.string().trim().max(191).optional(),
  subject: z.string().trim().max(191).optional(),
  academicLevel: z.string().trim().max(191).optional(),
  examType: z.string().trim().max(191).optional(),
  provider: z.enum(['google_drive', 's3']).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  status: z.enum(['active', 'deleted']).optional(),
  availability: z.enum(['available', 'missing', 'inaccessible', 'unknown']).optional(),
  mimeType: z.string().trim().max(191).optional(),
  audience: z.enum(['student', 'admin']).default('student'),
  includeUnavailable: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  order: z.enum(['newest', 'oldest', 'name']).default('newest'),
})

resourceRouter.get(
  '/',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const query = listQuerySchema.parse(req.query)
    if (!(await assertAdminAudience(req, res, query.audience))) return
    if (query.audience === 'student' && query.visibility === 'private') {
      throw new ResourceHttpError(403, 'RESOURCE_PRIVATE', 'A student listing cannot request private resources.')
    }

    const where: Prisma.FileWhereInput = {
      userId: req.user!.id,
      isResource: true,
      status: query.status ?? 'active',
      ...(query.category ? { category: query.category } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
      ...(query.academicLevel ? { academicLevel: query.academicLevel } : {}),
      ...(query.examType ? { examType: query.examType } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.mimeType ? { mimeType: query.mimeType } : {}),
      ...(query.availability ? { availability: query.availability } : {}),
    }
    if (query.visibility) where.visibility = query.visibility
    else if (query.audience === 'student') where.visibility = { in: ['students', 'public'] }
    if (query.audience === 'student' && query.includeUnavailable !== '1' && !query.availability) where.availability = 'available'

    const filters: Prisma.FileWhereInput[] = []
    if (query.q) {
      filters.push({
        OR: [
          { title: { contains: query.q } },
          { name: { contains: query.q } },
          { description: { contains: query.q } },
          { subject: { contains: query.q } },
          { category: { contains: query.q } },
        ],
      })
    }

    const { rows, hasMore, nextCursor } = await fetchPage(where, query.order, query.cursor, query.limit, filters)
    const origin = baseUrl(req)
    return res.json({
      resources: rows.map((row) => serializeResource(row, origin)),
      count: rows.length,
      hasMore,
      nextCursor,
      audience: query.audience,
    })
  }),
)

/* --------------------------------- health --------------------------------- */

resourceRouter.get(
  '/health',
  requireApiKey('files:read'),
  route(async (req, res) => {
    let databaseOk = true
    try {
      await prisma.$queryRawUnsafe('SELECT 1')
    } catch {
      databaseOk = false
    }
    let accounts: Array<{ id: string; provider: string }> = []
    try {
      accounts = await prisma.connectedAccount.findMany({
        where: { userId: req.user!.id, status: 'connected', provider: { in: ['google_drive', 's3'] } },
        select: { id: true, provider: true },
        take: 50,
      })
    } catch {
      databaseOk = false
    }
    const health = await Promise.all(
      accounts.map(async (account) => {
        try {
          return await getStorageAdapter(account.provider).check_storage_health(account.id, req.user!.id)
        } catch (error) {
          return {
            accountId: account.id,
            provider: account.provider,
            ok: false,
            detail: error instanceof Error ? error.message : 'Provider health check failed.',
          }
        }
      }),
    )
    let counts: number[] = [0, 0, 0, 0]
    try {
      counts = await Promise.all(
        (['available', 'missing', 'inaccessible', 'unknown'] as const).map((availability) =>
          prisma.file.count({ where: { userId: req.user!.id, isResource: true, status: 'active', availability } }),
        ),
      )
      databaseOk = true
    } catch {
      databaseOk = false
    }
    const healthy = databaseOk && health.every((entry) => entry.ok)
    const resources = {
      available: counts[0],
      missing: counts[1],
      inaccessible: counts[2],
      unknown: counts[3],
    }
    const checkedAt = new Date().toISOString()
    const detailed = buildStorageStatus({ databaseOk, accounts: health, resources, checkedAt })
    const declaration = buildStorageReport({
      connectedAccounts: health.length,
      googleDriveAccounts: health.filter((entry) => entry.provider === 'google_drive').length,
      s3Accounts: health.filter((entry) => entry.provider === 's3').length,
      degraded: !healthy,
      unavailable: !databaseOk,
      checkedAt,
    })
    const storage = {
      ...detailed,
      ...declaration,
      // Preserve the detailed provider checks while adopting the shared
      // display/capacity fields used by /api/v1/storage-status.
      database: detailed.database,
      accounts: detailed.accounts,
      resources: detailed.resources,
      reported: true,
    }
    noStore(res)
    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      storage,
      storageStatus: storage.status,
      reported: true,
      database: { ok: databaseOk },
      accounts: health,
      resources,
      checkedAt,
      note: 'Provider credentials are never returned. A degraded provider does not make metadata records available to students. `storage.reported` is always true so consumers never show "not reported yet".',
    })
  }),
)

/* ----------------------------- fast live counts --------------------------- */

/**
 * The public "live counts" widget should never wait for a Render cold start or
 * a provider HEAD request. This is a 30-second in-process cache over a few
 * cheap MySQL counts/groups; Edvanta's server also keeps a stale fallback.
 */
const COUNTS_TTL_MS = 30_000
const COUNTS_TTL_SECONDS = COUNTS_TTL_MS / 1000

type CountsResponse = {
  counts: ResourceCounts
  audience: 'student' | 'admin'
  includeUnavailable: boolean
  generatedAt: string
  ttlSeconds: number
  cached: boolean
}

const countsCache = new Map<string, { expiresAt: number; value: CountsResponse }>()
const countsQuerySchema = z.object({
  audience: z.enum(['student', 'admin']).default('student'),
  includeUnavailable: z.enum(['0', '1']).optional(),
})

async function computeResourceCounts(
  userId: string,
  audience: 'student' | 'admin',
  includeUnavailable: boolean,
): Promise<ResourceCounts> {
  const where = {
    userId,
    ...resourceCountsWhere(audience, includeUnavailable),
  } as Prisma.FileWhereInput

  const [total, availabilityRows, categoryRows, subjectRows, providerRows] = await Promise.all([
    prisma.file.count({ where }),
    prisma.file.groupBy({ by: ['availability'], where, _count: { _all: true } }),
    prisma.file.groupBy({ by: ['category'], where, _count: { _all: true } }),
    prisma.file.groupBy({ by: ['subject'], where, _count: { _all: true } }),
    prisma.file.groupBy({ by: ['provider'], where, _count: { _all: true } }),
  ])

  const counts = emptyResourceCounts()
  counts.total = Number(total)
  type AvailabilityKey = 'available' | 'missing' | 'inaccessible' | 'unknown'
  for (const row of availabilityRows as unknown as Array<{ availability: string; _count?: { _all?: number } }>) {
    const key = row.availability as AvailabilityKey
    if (key === 'available' || key === 'missing' || key === 'inaccessible' || key === 'unknown') {
      counts[key] = Number(row._count?._all ?? 0)
    }
  }
  type GroupRow = Array<Record<string, unknown> & { _count?: { _all?: number | bigint } }>
  counts.byCategory = normalizeCountGroups(categoryRows as unknown as GroupRow, 'category')
  counts.bySubject = normalizeCountGroups(subjectRows as unknown as GroupRow, 'subject')
  counts.byProvider = normalizeCountGroups(providerRows as unknown as GroupRow, 'provider')
  return counts
}

resourceRouter.get(
  '/counts',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const query = countsQuerySchema.parse(req.query)
    if (!(await assertAdminAudience(req, res, query.audience))) return
    const includeUnavailable = query.includeUnavailable === '1'
    const key = resourceCountsCacheKey(req.user!.id, query.audience, includeUnavailable)
    const now = Date.now()
    for (const [cacheKey, entry] of countsCache) {
      if (entry.expiresAt <= now) countsCache.delete(cacheKey)
    }
    const cached = countsCache.get(key)
    let body: CountsResponse
    if (cached && cached.expiresAt > now) {
      body = { ...cached.value, cached: true }
    } else {
      const counts = await computeResourceCounts(req.user!.id, query.audience, includeUnavailable)
      body = {
        counts,
        audience: query.audience,
        includeUnavailable,
        generatedAt: new Date().toISOString(),
        ttlSeconds: COUNTS_TTL_SECONDS,
        cached: false,
      }
      countsCache.set(key, { expiresAt: now + COUNTS_TTL_MS, value: body })
    }
    res.setHeader('Cache-Control', `private, max-age=${COUNTS_TTL_SECONDS}`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Counts-Cache', body.cached ? 'hit' : 'miss')
    return res.json(body)
  }),
)

/* --------------------------- on-demand reconciliation --------------------- */

const syncSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(2048).optional(),
  order: z.enum(['newest', 'oldest', 'name']).default('newest'),
})

resourceRouter.post(
  '/sync',
  requireApiKey('files:write'),
  requireRole('manage_resources'),
  route(async (req, res) => {
    const body = syncSchema.parse(req.body ?? {})
    const where: Prisma.FileWhereInput = { userId: req.user!.id, isResource: true, status: 'active' }
    const result = await syncResourceBatch(
      {
        list: async ({ cursor, limit }) => {
          const page = await fetchPage(where, body.order, cursor ? encodeResourceCursor(cursor) : undefined, limit)
          return page.rows
        },
        update: async (fileId, data) =>
          prisma.file.update({ where: { id: fileId }, data: data as unknown as Prisma.FileUpdateInput }),
        verify: async (file) => getStorageAdapter(file.provider).get_file_metadata(providerRef(file, req.user!.id)),
      },
      { userId: req.user!.id, cursor: decodeResourceCursor(body.cursor), limit: body.limit, order: body.order },
    )
    noStore(res)
    return res.json({
      checked: result.checked,
      changed: result.changed,
      missing: result.missing,
      inaccessible: result.inaccessible,
      problems: result.problems,
      nextCursor: result.nextCursor,
      note: 'Only availability and lastVerifiedAt are written. Administrator-owned metadata is never overwritten by a partial provider answer.',
    })
  }),
)

/* --------------------------------- upload --------------------------------- */

type UploadOutcome =
  | { ok: true; resource: ResourceRow; objectKey: string; created: boolean }
  | { ok: false; code: string; message: string }

function parseAndUpload(req: ApiKeyRequest): Promise<UploadOutcome> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) {
      return reject(new ResourceHttpError(400, 'RESOURCE_CONTENT_TYPE', 'multipart/form-data with metadata fields (sizeBytes or size) before a file/files/upload/document part is required.'))
    }

    const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: Record<string, string> = {}
    let fileSeen = false
    let settled = false
    let truncated = false
    let uploadPromise: Promise<UploadOutcome> | null = null

    const stop = (error: ResourceHttpError) => {
      if (settled) return
      settled = true
      req.unpipe(busboy)
      req.resume()
      reject(error)
    }
    const finish = (outcome: UploadOutcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }

    busboy.on('field', (name, value) => {
      fields[name] = value
    })

    busboy.on('file', (name, fileStream, info) => {
      if (!['file', 'files', 'upload', 'document'].includes(name)) {
        fileStream.resume()
        return
      }
      fileSeen = true
      let meta: ResourceUploadMeta
      try {
        meta = parseResourceUploadMeta(fields, { filename: info.filename, mimeType: info.mimeType })
      } catch (error) {
        fileStream.resume()
        const message = error instanceof z.ZodError
          ? error.issues.map((issue) => `${issue.path.join('.') || 'metadata'}: ${issue.message}`).join('; ')
          : error instanceof Error ? error.message : 'Upload metadata is invalid.'
        return stop(new ResourceHttpError(400, 'RESOURCE_META_INVALID', `Invalid upload metadata: ${message}. Include sizeBytes (or size/fileSize) so the file can be routed to a connected account.`))
      }
      if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
        fileStream.resume()
        return stop(new ResourceHttpError(413, 'UPLOAD_TOO_LARGE', `Files are limited to ${env.MAX_UPLOAD_BYTES} bytes.`))
      }

      const fileName = meta.fileName || info.filename || 'resource.bin'
      const mimeType = meta.mimeType || info.mimeType || 'application/octet-stream'
      const clientRequestId = meta.clientRequestId ?? randomUUID()
      fileStream.on('limit', () => {
        truncated = true
      })

      uploadPromise = createResourceRecord(
        {
          upload: (input) => putObject(input),
          update: async (fileId, data) => {
            try {
              const file = await prisma.file.update({
                where: { id: fileId },
                data: data as unknown as Prisma.FileUpdateInput,
              })
              return toResourceRow(file)
            } catch (error) {
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                throw new ResourceHttpError(
                  409,
                  'RESOURCE_IDEMPOTENCY_CONFLICT',
                  'Another upload with this clientRequestId is being registered. Retry the request; the stable object key prevents duplicates.',
                )
              }
              throw error
            }
          },
        },
        { userId: req.user!.id, meta, body: fileStream, fileName, clientRequestId },
      ).then(async (result) => {
        if (!result.ok || truncated) {
          if (result.ok) {
            // Busboy truncated the body. Do not leave an active resource.
            const adapter = getStorageAdapter(result.resource.provider)
            await adapter.delete_file(providerRef(result.resource, req.user!.id)).catch(() => undefined)
            await prisma.file
              .update({ where: { id: result.resource.id }, data: { status: 'deleted', deletedAt: new Date(), availability: 'missing' } })
              .catch(() => undefined)
          }
          return {
            ok: false as const,
            code: result.ok ? 'UPLOAD_TRUNCATED' : result.code,
            message: result.ok ? 'The upload was truncated before all declared bytes arrived.' : result.message,
          }
        }
        return result
      })
    })

    busboy.on('error', (error: unknown) =>
      stop(new ResourceHttpError(400, 'RESOURCE_MULTIPART_INVALID', error instanceof Error ? error.message : 'Malformed multipart body.')),
    )
    busboy.on('finish', () => {
      if (settled) return
      if (!fileSeen || !uploadPromise) {
        return stop(new ResourceHttpError(400, 'RESOURCE_FILE_REQUIRED', 'A file part named file/files/upload/document and metadata fields (including sizeBytes or size) must precede it.'))
      }
      uploadPromise.then(finish).catch((error) => {
        if (error instanceof ResourceHttpError) return stop(error)
        return stop(new ResourceHttpError(502, 'RESOURCE_UPLOAD_FAILED', error instanceof Error ? error.message : 'The upload failed.'))
      })
    })

    req.pipe(busboy)
  })
}

/** Shared handler so `/resources`, `/resources/upload` and `/upload` behave identically. */
export const uploadResourceHandler = route(async (req: ApiKeyRequest, res) => {
  const result = await parseAndUpload(req)
  if (!result.ok) throw new ResourceHttpError(uploadStatus(result.code), result.code, result.message)
  await createAuditLog(req.user!.id, 'CREATE_EDVANTA_RESOURCE', 'file', result.resource.id, {
    objectKey: result.objectKey,
    provider: result.resource.provider,
    visibility: result.resource.visibility,
  })
  noStore(res)
  return res.status(201).json({
    resource: serializeResource(result.resource, baseUrl(req)),
    objectKey: result.objectKey,
    idempotent: true,
    note: 'Retrying with the same clientRequestId replaces this object instead of creating a duplicate.',
  })
})

resourceRouter.post('/', requireApiKey('files:write'), requireRole('manage_resources'), uploadResourceHandler)
resourceRouter.post('/upload', requireApiKey('files:write'), requireRole('manage_resources'), uploadResourceHandler)

/* ------------------------------- bulk download ---------------------------- */

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  audience: z.enum(['student', 'admin']).default('student'),
})

type BulkProblem = { id: string; name: string; code: string; message: string }

resourceRouter.post(
  '/bulk-download',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const body = bulkSchema.parse(req.body ?? {})
    if (!(await assertAdminAudience(req, res, body.audience))) return

    const requested = await prisma.file.findMany({
      where: { id: { in: body.ids }, userId: req.user!.id, isResource: true },
    })
    const byId = new Map(requested.map((file) => [file.id, file]))
    const problems: BulkProblem[] = []
    const usable: PrismaFile[] = []

    for (const id of body.ids) {
      const row = byId.get(id)
      if (!row) {
        problems.push({ id, name: id, code: 'RESOURCE_NOT_FOUND', message: 'No such resource.' })
        continue
      }
      if (body.audience === 'student' && row.visibility === 'private') {
        problems.push({ id, name: row.name, code: 'RESOURCE_PRIVATE', message: 'Private resource; the end user is not authorised.' })
        continue
      }
      const problem = availabilityProblem(row)
      if (problem) {
        problems.push({ id, name: row.name, code: problem.code, message: problem.message })
        continue
      }
      usable.push(row)
    }

    // Preflight HEAD/get: never stream a ZIP that would silently miss a file.
    const verified: PrismaFile[] = []
    for (const row of usable) {
      try {
        const metadata = await getStorageAdapter(row.provider).get_file_metadata(providerRef(row, req.user!.id))
        if (metadata.availability !== 'available') {
          problems.push({ id: row.id, name: row.name, code: 'RESOURCE_PROVIDER_UNAVAILABLE', message: metadata.detail ?? 'The provider cannot serve this file.' })
          await prisma.file
            .update({ where: { id: row.id }, data: { availability: metadata.availability, lastVerifiedAt: new Date() } })
            .catch(() => undefined)
          continue
        }
        verified.push(row)
      } catch (error) {
        problems.push({ id: row.id, name: row.name, code: 'RESOURCE_PROVIDER_UNAVAILABLE', message: error instanceof Error ? error.message : 'Provider check failed.' })
      }
    }

    if (verified.length === 0) {
      throw new ResourceHttpError(502, 'BULK_ALL_FILES_UNAVAILABLE', 'None of the selected files could be retrieved.', { problems })
    }
    const limits = checkBulkLimits(verified, { maxFiles: env.RESOURCE_BULK_MAX_FILES, maxBytes: env.RESOURCE_BULK_MAX_BYTES })
    if (!limits.ok) throw new ResourceHttpError(413, limits.code, limits.message, { problems })

    const names = resolveZipNames(verified.map((file) => ({ id: file.id, name: file.name })))
    const nameById = new Map(names.map((entry) => [entry.id, entry.name]))
    res.status(200)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', 'attachment; filename="edvanta-resources.zip"')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Resource-Bulk-Error-Count', String(problems.length))
    res.setHeader('X-Resource-Bulk-Skipped', problems.map((problem) => problem.id).join(','))

    const archive = new ZipArchive({ zlib: { level: 6 } })
    let destroyed = false
    const abort = (error: Error) => {
      if (destroyed) return
      destroyed = true
      console.error('[resources] bulk download aborted:', error.message)
      archive.abort()
      res.destroy(error)
    }
    archive.on('error', abort)
    archive.pipe(res)

    for (const row of verified) {
      try {
        const opened = await getStorageAdapter(row.provider).open_read_stream(providerRef(row, req.user!.id))
        opened.stream.on('error', abort)
        archive.append(opened.stream, { name: nameById.get(row.id) ?? safeResourceFileName(row.name) })
      } catch (error) {
        abort(error instanceof Error ? error : new Error('Could not open a provider stream.'))
        return
      }
    }
    if (problems.length > 0) {
      const text = [
        'Some selected resources could not be included in this archive.',
        ...problems.map((problem) => `${problem.code} ${problem.id} ${problem.name}: ${problem.message}`),
      ].join('\n')
      archive.append(Buffer.from(text, 'utf8'), { name: '_download-errors.txt' })
    }
    await archive.finalize()
  }),
)

/* -------------------------------- one resource ---------------------------- */

resourceRouter.get(
  '/:id',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    noStore(res)
    return res.json({ resource: serializeResource(await toResourceRow(row), baseUrl(req)) })
  }),
)

resourceRouter.patch(
  '/:id',
  requireApiKey('files:write'),
  requireRole('manage_resources'),
  route(async (req, res) => {
    const patch = resourcePatchSchema.parse(req.body ?? {})
    const row = await findResource(req, String(req.params.id), 'admin')
    const data: Prisma.FileUpdateInput = { lastModifiedBy: req.user!.id }
    if (patch.title !== undefined) data.title = patch.title
    if (patch.description !== undefined) data.description = patch.description
    if (patch.category !== undefined) data.category = patch.category
    if (patch.subject !== undefined) data.subject = patch.subject
    if (patch.academicLevel !== undefined) data.academicLevel = patch.academicLevel
    if (patch.examType !== undefined) data.examType = patch.examType
    if (patch.visibility !== undefined) data.visibility = patch.visibility
    if (patch.metadata !== undefined) data.resourceMetadata = patch.metadata as Prisma.InputJsonValue
    const updated = await prisma.file.update({ where: { id: row.id }, data })
    await createAuditLog(req.user!.id, 'UPDATE_EDVANTA_RESOURCE', 'file', row.id, { fields: Object.keys(patch) })
    noStore(res)
    return res.json({ resource: serializeResource(await toResourceRow(updated), baseUrl(req)) })
  }),
)

resourceRouter.delete(
  '/:id',
  requireApiKey('files:delete'),
  requireRole('manage_resources'),
  route(async (req, res) => {
    const permanent = ['1', 'true'].includes(String(req.query.permanent ?? ''))
    const row = await findResource(req, String(req.params.id), 'admin')
    if (permanent) {
      try {
        await getStorageAdapter(row.provider).delete_file(providerRef(row, req.user!.id))
      } catch (error) {
        throw new ResourceHttpError(502, 'RESOURCE_DELETE_FAILED', error instanceof Error ? error.message : 'The provider refused to delete the file.')
      }
      await prisma.file.delete({ where: { id: row.id } })
    } else {
      await prisma.file.update({ where: { id: row.id }, data: { status: 'deleted', deletedAt: new Date(), availability: 'unknown' } })
    }
    await createAuditLog(req.user!.id, 'DELETE_EDVANTA_RESOURCE', 'file', row.id, { permanent })
    noStore(res)
    return res.json({ status: 'ok', permanent, id: row.id })
  }),
)

resourceRouter.post(
  '/:id/verify',
  requireApiKey('files:write'),
  requireRole('manage_resources'),
  route(async (req, res) => {
    const row = await findResource(req, String(req.params.id), 'admin')
    const metadata = await getStorageAdapter(row.provider).get_file_metadata(providerRef(row, req.user!.id))
    const updated = await prisma.file.update({
      where: { id: row.id },
      data: { availability: metadata.availability, lastVerifiedAt: new Date() },
    })
    noStore(res)
    return res.json({
      resource: serializeResource(await toResourceRow(updated), baseUrl(req)),
      providerDetail: metadata.detail ?? null,
    })
  }),
)

/* ------------------------- preview / download URLs ------------------------ */

resourceRouter.get(
  '/:id/access',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    const problem = availabilityProblem(row)
    if (problem) throw problem
    const previewInfo = previewFor(row.mimeType)
    const ttl = Number(req.query.ttlSeconds ?? env.RESOURCE_URL_TTL_SECONDS)
    const urls = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { ttlSeconds: ttl })
    const download = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { download: true, ttlSeconds: ttl })
    noStore(res)
    return res.json({ preview: { ...urls, supported: previewInfo.supported, mode: previewInfo.mode, reason: previewInfo.reason }, download })
  }),
)

resourceRouter.get(
  '/:id/preview-url',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    const problem = availabilityProblem(row)
    if (problem) throw problem
    const info = previewFor(row.mimeType)
    const ttl = Number(req.query.ttlSeconds ?? env.RESOURCE_URL_TTL_SECONDS)
    const download = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { download: true, ttlSeconds: ttl })
    if (!info.supported) {
      noStore(res)
      return res.status(415).json({
        code: 'PREVIEW_UNSUPPORTED',
        message: info.reason,
        previewMode: info.mode,
        mimeType: row.mimeType,
        download,
      })
    }
    const preview = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { ttlSeconds: ttl })
    noStore(res)
    return res.json({ ...preview, previewMode: info.mode, mimeType: row.mimeType })
  }),
)

resourceRouter.get(
  '/:id/download-url',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    const problem = availabilityProblem(row)
    if (problem) throw problem
    const ttl = Number(req.query.ttlSeconds ?? env.RESOURCE_URL_TTL_SECONDS)
    const download = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { download: true, ttlSeconds: ttl })
    noStore(res)
    return res.json(download)
  }),
)

resourceRouter.get(
  '/:id/preview',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    const problem = availabilityProblem(row)
    if (problem) throw problem
    const info = previewFor(row.mimeType)
    if (!info.supported) {
      const download = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { download: true })
      noStore(res)
      return res.status(415).json({ code: 'PREVIEW_UNSUPPORTED', message: info.reason, download })
    }
    const preview = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey })
    noStore(res)
    return res.redirect(302, preview.url)
  }),
)

resourceRouter.get(
  '/:id/download',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    const problem = availabilityProblem(row)
    if (problem) throw problem
    const download = await mintResourceUrl(req, { id: row.id, userId: row.userId, objectKey: row.objectKey }, { download: true })
    noStore(res)
    return res.redirect(302, download.url)
  }),
)

/**
 * Authenticated byte streaming for Edvanta's server-side proxy. Supports Range
 * for large PDFs/media and sets safe headers; the browser still never sees a
 * cloud credential. Use `/preview-url` when the browser should load bytes
 * directly instead.
 */
resourceRouter.get(
  '/:id/content',
  requireApiKey('files:read'),
  route(async (req, res) => {
    const audience = String(req.query.audience ?? 'student') === 'admin' ? 'admin' : 'student'
    if (!(await assertAdminAudience(req, res, audience))) return
    const row = await findResource(req, String(req.params.id), audience)
    const problem = availabilityProblem(row)
    if (problem) throw problem
    const wantsDownload = ['1', 'true'].includes(String(req.query.download ?? ''))
    let opened
    try {
      opened = await getStorageAdapter(row.provider).open_read_stream(
        providerRef(row, req.user!.id),
        req.headers.range,
        wantsDownload ? 'download' : 'preview',
      )
    } catch (error) {
      const availability = error instanceof ProviderOperationError ? error.availability : 'unknown'
      if (availability === 'missing') {
        await prisma.file.update({ where: { id: row.id }, data: { availability: 'missing', lastVerifiedAt: new Date() } }).catch(() => undefined)
      }
      throw new ResourceHttpError(
        availability === 'missing' ? 410 : 502,
        'RESOURCE_STREAM_FAILED',
        error instanceof Error ? error.message : 'The storage provider could not serve this file.',
      )
    }
    noStore(res)
    res.status(opened.contentRange ? 206 : 200)
    res.setHeader('Content-Type', opened.contentType)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader(
      'Content-Disposition',
      `${wantsDownload ? 'attachment' : 'inline'}; filename="${safeResourceFileName(opened.fileName).replaceAll('"', '')}"`,
    )
    if (opened.contentLength) res.setHeader('Content-Length', opened.contentLength)
    if (opened.contentRange) res.setHeader('Content-Range', opened.contentRange)
    opened.stream.on('error', (error) => {
      console.error('[resources] stream failed:', error.message)
      if (!res.headersSent) res.status(502).json({ code: 'RESOURCE_STREAM_FAILED', message: error.message })
      else res.destroy(error)
    })
    opened.stream.pipe(res)
  }),
)
