import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { objectKeyProblem } from '../public-api/objects.shared.js'

/**
 * Pure, testable core of the unified educational-resource registry.
 *
 * No database or cloud SDK is imported here: the HTTP layer supplies real
 * Prisma/provider operations, while the tests supply in-memory fakes. That is
 * what makes a mocked provider test distinguishable from a live cloud test.
 */

export const VISIBILITIES = ['private', 'students', 'public'] as const
export type Visibility = (typeof VISIBILITIES)[number]
export type StorageProviderName = 'google_drive' | 's3'
export type AvailabilityState = 'available' | 'missing' | 'inaccessible' | 'unknown'

const sizeSchema = z.union([z.coerce.number().int().positive(), z.string().regex(/^[0-9]+$/)]).transform((value) => BigInt(value))

/** Metadata accepted at upload time. `sizeBytes` is the declared upload size. */
export const resourceUploadSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(5000).nullable().optional(),
    category: z.string().trim().max(191).nullable().optional(),
    subject: z.string().trim().max(191).nullable().optional(),
    academicLevel: z.string().trim().max(191).nullable().optional(),
    examType: z.string().trim().max(191).nullable().optional(),
    visibility: z.enum(VISIBILITIES).default('students'),
    provider: z.enum(['google_drive', 's3']).optional(),
    clientRequestId: z.string().trim().min(8).max(191).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    fileName: z.string().trim().min(1).max(255).optional(),
    mimeType: z.string().trim().min(1).max(191).optional(),
    sizeBytes: sizeSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

/** Metadata that may be changed without re-uploading any bytes. */
export const resourcePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    category: z.string().trim().max(191).nullable().optional(),
    subject: z.string().trim().max(191).nullable().optional(),
    academicLevel: z.string().trim().max(191).nullable().optional(),
    examType: z.string().trim().max(191).nullable().optional(),
    visibility: z.enum(VISIBILITIES).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type ResourceUploadMeta = z.infer<typeof resourceUploadSchema>
export type ResourcePatch = z.infer<typeof resourcePatchSchema>

/** Normalizes a browser-supplied filename without destroying the extension. */
export function safeResourceFileName(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180)
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'resource.bin'
}

export function safeClientRequestId(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 80) || randomUUID()
}

/**
 * The object key is a stable, provider-independent locator derived from the
 * retry token. Retrying the same upload PUTs to the same key and replaces the
 * metadata row; it cannot create a duplicate resource.
 */
export function buildResourceObjectKey(clientRequestId: string, fileName: string): string {
  const key = `edvanta/resources/${safeClientRequestId(clientRequestId)}/${safeResourceFileName(fileName)}`
  const problem = objectKeyProblem(key)
  if (problem) throw new ResourceInputError(`The derived object key is invalid (${problem}).`, 'RESOURCE_KEY_INVALID')
  return key
}

export class ResourceInputError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'ResourceInputError'
  }
}

export type PreviewMode = 'pdf' | 'image' | 'text' | 'google-document' | 'office' | 'unsupported'

export type PreviewInfo = {
  supported: boolean
  mode: PreviewMode
  /** A safe explanation when direct browser rendering is not available. */
  reason: string | null
}

const RASTER_IMAGES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv'])
const GOOGLE_DOCUMENTS = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
])
const OFFICE_TYPES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

/**
 * No Office-format conversion service is configured in either project, so those
 * files are honestly reported as download-only rather than handed to a public
 * third-party viewer (which would leak a private document).
 */
export function previewFor(mimeType: string | undefined): PreviewInfo {
  const type = (mimeType ?? '').toLowerCase().split(';')[0]!.trim()
  if (type === 'application/pdf') return { supported: true, mode: 'pdf', reason: null }
  if (RASTER_IMAGES.has(type)) return { supported: true, mode: 'image', reason: null }
  if (TEXT_TYPES.has(type)) return { supported: true, mode: 'text', reason: null }
  if (GOOGLE_DOCUMENTS.has(type)) return { supported: true, mode: 'google-document', reason: null }
  if (OFFICE_TYPES.has(type)) {
    return {
      supported: false,
      mode: 'office',
      reason: 'Word, Excel and PowerPoint files cannot be rendered directly by the browser and no server-side conversion service is configured. Download the file to view it.',
    }
  }
  return { supported: false, mode: 'unsupported', reason: 'Direct preview is unavailable for this file type. Download the file to open it.' }
}

/** Keyset pagination token - no OFFSET, so a growing collection stays fast. */
export type ResourceCursor = { createdAt: string; id: string; name?: string; order: 'newest' | 'oldest' | 'name' }

export function encodeResourceCursor(cursor: ResourceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeResourceCursor(token: string | undefined | null): ResourceCursor | null {
  if (!token) return null
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as ResourceCursor
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.id !== 'string' || !['newest', 'oldest', 'name'].includes(parsed.order)) return null
    if (Number.isNaN(Date.parse(parsed.createdAt))) return null
    if (parsed.order === 'name' && typeof parsed.name !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/** Meaningful, path-traversal-free, collision-free names inside a bulk ZIP. */
export function resolveZipNames(items: Array<{ id: string; name: string }>): Array<{ id: string; name: string }> {
  const used = new Set<string>()
  return items.map((item) => {
    const safe = safeResourceFileName(item.name)
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const extension = dot > 0 ? safe.slice(dot) : ''
    let candidate = safe
    let suffix = 2
    while (used.has(candidate.toLowerCase())) {
      candidate = `${stem} (${suffix++})${extension}`
    }
    used.add(candidate.toLowerCase())
    return { id: item.id, name: candidate }
  })
}

export type BulkLimitCheck = { ok: true; totalBytes: bigint } | { ok: false; code: string; message: string }

export function checkBulkLimits(
  files: Array<{ sizeBytes: bigint }>,
  limits: { maxFiles: number; maxBytes: number },
): BulkLimitCheck {
  if (files.length === 0) return { ok: false, code: 'BULK_EMPTY', message: 'Select at least one resource.' }
  if (files.length > limits.maxFiles) {
    return { ok: false, code: 'BULK_TOO_MANY_FILES', message: `A bulk download is limited to ${limits.maxFiles} files.` }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0n)
  if (totalBytes > BigInt(limits.maxBytes)) {
    return { ok: false, code: 'BULK_TOO_LARGE', message: `A bulk download is limited to ${limits.maxBytes} bytes in total.` }
  }
  return { ok: true, totalBytes }
}

export type ResourceRow = {
  id: string
  userId: string
  name: string
  mimeType: string
  sizeBytes: bigint
  provider: string
  providerFileId: string
  objectKey: string | null
  bucketName?: string | null
  status: string
  title: string | null
  description: string | null
  category: string | null
  subject: string | null
  academicLevel: string | null
  examType: string | null
  visibility: string
  clientRequestId: string | null
  resourceMetadata: unknown
  uploadedBy: string | null
  lastModifiedBy: string | null
  availability: string
  lastVerifiedAt: Date | null
  checksum: string | null
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
  connectedAccountId: string
}

/**
 * The wire shape Edvanta consumes. `id` is the only stable identifier; the
 * provider-specific locator is exposed for administrators but never used as a
 * cross-provider id. URLs are endpoint paths, not expiring signed links.
 */
export function serializeResource(file: ResourceRow, baseUrl: string) {
  const provider = file.provider === 'google_drive' ? 'google_drive' : file.provider === 's3' ? 's3' : file.provider
  const preview = previewFor(file.mimeType)
  const available = file.status === 'active' && file.availability !== 'missing' && file.availability !== 'inaccessible'
  return {
    id: file.id,
    title: file.title ?? file.name,
    originalFilename: file.name,
    displayFilename: safeResourceFileName(file.title ?? file.name),
    mimeType: file.mimeType,
    fileSize: file.sizeBytes.toString(),
    checksum: file.checksum,
    storageProvider: provider,
    providerFileId: file.providerFileId,
    bucketName: provider === 's3' ? file.bucketName ?? null : null,
    objectKey: file.objectKey,
    googleDriveFileId: provider === 'google_drive' ? file.providerFileId : null,
    previewSupported: preview.supported,
    previewMode: preview.mode,
    previewReason: preview.reason,
    category: file.category,
    subject: file.subject,
    academicLevel: file.academicLevel,
    examType: file.examType,
    description: file.description,
    metadata: file.resourceMetadata ?? null,
    uploadedBy: file.uploadedBy ?? file.userId,
    lastModifiedBy: file.lastModifiedBy,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    visibility: file.visibility,
    status: file.status,
    availability: file.availability,
    lastVerifiedAt: file.lastVerifiedAt?.toISOString() ?? null,
    available,
    urls: {
      metadata: `${baseUrl}/api/v1/resources/${file.id}`,
      preview: `${baseUrl}/api/v1/resources/${file.id}/preview`,
      previewUrl: `${baseUrl}/api/v1/resources/${file.id}/preview-url`,
      download: `${baseUrl}/api/v1/resources/${file.id}/download`,
      downloadUrl: `${baseUrl}/api/v1/resources/${file.id}/download-url`,
      content: `${baseUrl}/api/v1/resources/${file.id}/content`,
    },
  }
}

export type CreateResourceDeps = {
  upload: (input: {
    userId: string
    key: string
    body: NodeJS.ReadableStream
    sizeBytes: bigint
    mimeType: string
    provider?: StorageProviderName
    source: 'api'
  }) => Promise<{ ok: boolean; file?: { id: string }; code?: string; message?: string }>
  update: (fileId: string, data: Record<string, unknown>) => Promise<ResourceRow>
}

/**
 * Upload + registry write, with dependency injection.
 *
 * The provider bytes are written first. Only a confirmed upload triggers a
 * metadata update, so a retried or failed request can never leave an `active`
 * resource pointing at a missing object.
 */
export async function createResourceRecord(
  deps: CreateResourceDeps,
  input: {
    userId: string
    meta: ResourceUploadMeta
    body: NodeJS.ReadableStream
    fileName: string
    clientRequestId: string
    now?: Date
  },
): Promise<{ ok: true; resource: ResourceRow; objectKey: string; created: boolean } | { ok: false; code: string; message: string }> {
  const { userId, meta, body, fileName, clientRequestId } = input
  const now = input.now ?? new Date()
  let objectKey: string
  try {
    objectKey = buildResourceObjectKey(clientRequestId, fileName)
  } catch (error) {
    const problem = error as ResourceInputError
    return { ok: false, code: problem.code ?? 'RESOURCE_KEY_INVALID', message: problem.message }
  }

  const uploaded = await deps.upload({
    userId,
    key: objectKey,
    body,
    sizeBytes: meta.sizeBytes,
    mimeType: meta.mimeType || 'application/octet-stream',
    provider: meta.provider,
    source: 'api',
  })
  if (!uploaded.ok || !uploaded.file) {
    return {
      ok: false,
      code: uploaded.code ?? 'UPLOAD_FAILED',
      message: uploaded.message ?? 'The storage provider refused the upload.',
    }
  }

  const resource = await deps.update(uploaded.file.id, {
    isResource: true,
    title: meta.title,
    description: meta.description ?? null,
    category: meta.category ?? null,
    subject: meta.subject ?? null,
    academicLevel: meta.academicLevel ?? null,
    examType: meta.examType ?? null,
    visibility: meta.visibility,
    clientRequestId,
    // Only write JSON when supplied: Prisma distinguishes JSON null from a
    // database NULL, and an absent field must not erase an existing value.
    ...(meta.metadata ? { resourceMetadata: meta.metadata } : {}),
    uploadedBy: userId,
    lastModifiedBy: userId,
    availability: 'available',
    lastVerifiedAt: now,
    status: 'active',
    deletedAt: null,
  })
  return { ok: true, resource, objectKey, created: true }
}

export type SyncDeps = {
  list: (input: { userId: string; cursor: ResourceCursor | null; limit: number }) => Promise<ResourceRow[]>
  update: (fileId: string, data: Record<string, unknown>) => Promise<unknown>
  verify: (file: ResourceRow) => Promise<{ availability: AvailabilityState; detail?: string }>
  now?: () => Date
}

/**
 * On-demand reconciliation of registry rows against the actual provider.
 *
 * Only `availability` and `lastVerifiedAt` are written. Names, categories and
 * sizes are administrator-owned metadata and are never overwritten with a
 * partial provider answer (a Drive-native document reports no size at all).
 */
export async function syncResourceBatch(deps: SyncDeps, input: { userId: string; cursor: ResourceCursor | null; limit: number; order: ResourceCursor['order'] }) {
  const rows = await deps.list({ userId: input.userId, cursor: input.cursor, limit: input.limit })
  const now = deps.now?.() ?? new Date()
  let changed = 0
  let missing = 0
  let inaccessible = 0
  const problems: Array<{ id: string; availability: AvailabilityState; detail?: string }> = []

  for (const row of rows) {
    const result = await deps.verify(row)
    if (result.availability === 'missing') missing += 1
    if (result.availability === 'inaccessible') inaccessible += 1
    if (result.availability !== 'available') problems.push({ id: row.id, availability: result.availability, detail: result.detail })
    if (row.availability !== result.availability) changed += 1
    await deps.update(row.id, { availability: result.availability, lastVerifiedAt: now })
  }

  const last = rows[rows.length - 1]
  const nextCursor = rows.length === input.limit && last
    ? encodeResourceCursor({ createdAt: last.createdAt.toISOString(), id: last.id, name: last.name, order: input.order })
    : null
  return { checked: rows.length, changed, missing, inaccessible, problems, nextCursor }
}
