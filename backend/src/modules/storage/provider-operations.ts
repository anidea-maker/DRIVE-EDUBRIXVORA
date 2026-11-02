import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { google } from 'googleapis'
import { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder } from '../google/google.service.js'
import { createS3Client, describeS3Error, getS3ConfigForAccount } from '../s3/s3.service.js'
import { googleDownloadExportMimeTypes, googlePreviewExportMimeTypes, normalizeHeaders, withExtension } from '../files/stream-google-file.js'

/**
 * Provider-level operations used by the unified resource registry.
 *
 * This module deliberately imports only the provider services, never the
 * object/public API modules, so verification can also be used from inside an
 * upload without creating a circular dependency. Every operation resolves the
 * account from the database: a row's `provider` + `providerFileId` +
 * `connectedAccountId` is the only locator, and a Google Drive id is never
 * treated as an S3 key.
 */
export type ProviderFileRef = {
  id?: string
  userId?: string
  name?: string
  mimeType?: string
  sizeBytes?: bigint
  provider: string
  providerFileId: string
  connectedAccountId: string
}

export type Availability = 'available' | 'missing' | 'inaccessible' | 'unknown'

export type ProviderMetadata = {
  availability: Availability
  sizeBytes?: bigint
  mimeType?: string
  /** Safe, credential-free explanation for logs and API responses. */
  detail?: string
}

export class ProviderOperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly availability: Availability = 'unknown',
  ) {
    super(message)
    this.name = 'ProviderOperationError'
  }
}

function errorStatus(error: unknown): number | undefined {
  const candidate = error as { code?: number | string; status?: number; statusCode?: number; $metadata?: { httpStatusCode?: number } } | null
  const raw = candidate?.code ?? candidate?.status ?? candidate?.statusCode ?? candidate?.$metadata?.httpStatusCode
  const status = typeof raw === 'string' ? Number(raw) : raw
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined
}

function isTransient(error: unknown) {
  const status = errorStatus(error)
  const text = `${(error as { name?: string; code?: string; message?: string })?.name ?? ''} ${(error as { message?: string })?.message ?? ''}`
  return (status !== undefined && (status === 429 || status >= 500)) || /ETIMEDOUT|ECONNRESET|EAI_AGAIN|rateLimitExceeded|userRateLimitExceeded|backendError/i.test(text)
}

/** Two attempts for rate limits and temporary 5xx responses; never for auth/404. */
async function withTransientRetry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isTransient(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
  }
  throw lastError
}

function s3Problem(error: unknown, config: { bucket: string; endpoint: string | null; region: string }): ProviderOperationError {
  const described = describeS3Error(error, config)
  const status = errorStatus(error)
  const availability: Availability =
    status === 404 || /NoSuchKey|NotFound/i.test(`${(error as { name?: string })?.name ?? ''} ${(error as { Code?: string })?.Code ?? ''}`)
      ? 'missing'
      : status === 401 || status === 403
        ? 'inaccessible'
        : 'unknown'
  return new ProviderOperationError(described.message, described.code, availability)
}

function googleProblem(error: unknown): ProviderOperationError {
  const status = errorStatus(error)
  const name = (error as { name?: string; code?: string })?.name ?? ''
  const described = `${name || 'GoogleDriveError'}: ${error instanceof Error ? error.message : String(error)}`
  const availability: Availability =
    status === 404 || /notFound/i.test(name)
      ? 'missing'
      : status === 401 || status === 403 || /invalid_grant|unauthorized|insufficient/i.test(described)
        ? 'inaccessible'
        : 'unknown'
  // The provider's raw message is useful to an operator but is not a secret;
  // it can contain a file id. Never include tokens or Authorization headers.
  return new ProviderOperationError(described.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'), 'GOOGLE_DRIVE_OPERATION_FAILED', availability)
}

/** HEAD-like existence check. Does not download the file. */
export async function verifyProviderFile(file: ProviderFileRef): Promise<ProviderMetadata> {
  if (!file.providerFileId) return { availability: 'missing', detail: 'No provider file id is recorded.' }

  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId, file.userId)
    const client = createS3Client(config)
    try {
      const head = await withTransientRetry(() => client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: file.providerFileId })))
      return {
        availability: 'available',
        sizeBytes: head.ContentLength === undefined ? undefined : BigInt(head.ContentLength),
        mimeType: head.ContentType ?? undefined,
      }
    } catch (error) {
      const problem = s3Problem(error, config)
      return { availability: problem.availability, detail: problem.message }
    }
  }

  if (file.provider === 'google_drive') {
    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: file.connectedAccountId } })
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    try {
      // supportsAllDrives makes shared-drive files addressable when the account
      // has permission, without making anything public.
      const metadata = await withTransientRetry(() =>
        drive.files.get({
          fileId: file.providerFileId,
          fields: 'id,name,mimeType,size,trashed',
          supportsAllDrives: true,
        }),
      )
      if (metadata.data.trashed) return { availability: 'missing', detail: 'The file is in Google Drive trash.' }
      return {
        availability: 'available',
        sizeBytes: metadata.data.size ? BigInt(metadata.data.size) : undefined,
        mimeType: metadata.data.mimeType ?? undefined,
      }
    } catch (error) {
      const problem = googleProblem(error)
      return { availability: problem.availability, detail: problem.message }
    }
  }

  return { availability: 'unknown', detail: `Unknown storage provider "${file.provider}".` }
}

/** Streams bytes without buffering the file in application memory. */
export async function openProviderReadStream(
  file: ProviderFileRef,
  range?: string,
  purpose: 'preview' | 'download' = 'download',
): Promise<{
  stream: Readable
  contentType: string
  contentLength?: string
  contentRange?: string
  fileName: string
}> {
  if (!file.providerFileId) throw new ProviderOperationError('No provider file id is recorded.', 'PROVIDER_FILE_ID_MISSING', 'missing')
  const fileName = file.name || 'download'

  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId, file.userId)
    const client = createS3Client(config)
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, ...(range ? { Range: range } : {}) }))
      const body = response.Body as Readable | undefined
      if (!body) throw new ProviderOperationError('The object has no body.', 'EMPTY_OBJECT', 'missing')
      return {
        stream: body,
        contentType: response.ContentType ?? file.mimeType ?? 'application/octet-stream',
        contentLength: response.ContentLength === undefined ? undefined : String(response.ContentLength),
        contentRange: response.ContentRange,
        fileName,
      }
    } catch (error) {
      if (error instanceof ProviderOperationError) throw error
      throw s3Problem(error, config)
    }
  }

  if (file.provider === 'google_drive') {
    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: file.connectedAccountId } })
    const auth = await getAuthedGoogleClient(account)
    const headers = normalizeHeaders(await auth.getRequestHeaders())
    const exportMap = purpose === 'preview' ? googlePreviewExportMimeTypes : googleDownloadExportMimeTypes
    const exportTarget = exportMap[file.mimeType ?? '']
    const url = exportTarget
      ? `https://www.googleapis.com/drive/v3/files/${file.providerFileId}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
      : `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
    try {
      const response = await withTransientRetry(async () => {
        const result = await fetch(url, { headers: { ...headers, ...(range && !exportTarget ? { Range: range } : {}) } })
        if (!result.ok) {
          const err = new Error((await result.text().catch(() => result.statusText)).slice(0, 500)) as Error & { status?: number }
          err.status = result.status
          throw err
        }
        return result
      })
      if (!response.body) throw new ProviderOperationError('Google Drive returned no body.', 'EMPTY_OBJECT', 'missing')
      return {
        stream: Readable.fromWeb(response.body as never),
        contentType: exportTarget?.mimeType ?? file.mimeType ?? 'application/octet-stream',
        contentLength: response.headers.get('content-length') ?? undefined,
        contentRange: response.headers.get('content-range') ?? undefined,
        fileName: exportTarget ? withExtension(fileName, exportTarget.extension) : fileName,
      }
    } catch (error) {
      if (error instanceof ProviderOperationError) throw error
      throw googleProblem(error)
    }
  }

  throw new ProviderOperationError(`Unknown storage provider "${file.provider}".`, 'UNKNOWN_PROVIDER', 'unknown')
}

/** Deletes the underlying provider object. Callers still own the metadata row. */
export async function deleteProviderFile(file: ProviderFileRef): Promise<void> {
  if (!file.providerFileId) return
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId, file.userId)
    const client = createS3Client(config)
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
    return
  }
  if (file.provider === 'google_drive') {
    const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: file.connectedAccountId } })
    const auth = await getAuthedGoogleClient(account)
    await google.drive({ version: 'v3', auth }).files.delete({ fileId: file.providerFileId, supportsAllDrives: true })
    return
  }
  throw new ProviderOperationError(`Unknown storage provider "${file.provider}".`, 'UNKNOWN_PROVIDER')
}

export type ProviderListPage = {
  items: Array<{ providerFileId: string; name: string; sizeBytes: string; mimeType: string; modifiedAt: string | null }>
  nextCursor: string | null
}

/**
 * Admin-only provider listing with pagination. Discovery endpoints use the
 * database registry instead; this exists for reconciliation and health checks,
 * and never lists every provider file on a student page request.
 */
export async function listProviderPage(input: {
  accountId: string
  userId: string
  cursor?: string | null
  limit?: number
}): Promise<ProviderListPage> {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: input.accountId, userId: input.userId } })
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000))

  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, input.userId)
    const client = createS3Client(config)
    const response = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: limit, ContinuationToken: input.cursor || undefined }),
    )
    return {
      items: (response.Contents ?? []).map((object) => ({
        providerFileId: object.Key ?? '',
        name: (object.Key ?? '').split('/').pop() ?? object.Key ?? '',
        sizeBytes: String(object.Size ?? 0),
        mimeType: 'application/octet-stream',
        modifiedAt: object.LastModified?.toISOString() ?? null,
      })),
      nextCursor: response.IsTruncated ? response.NextContinuationToken ?? null : null,
    }
  }

  if (account.provider === 'google_drive') {
    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const appFolderId = await ensureGoogleAppFolder(account)
    const response = await drive.files.list({
      q: `'${appFolderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      spaces: 'drive',
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
      pageSize: limit,
      pageToken: input.cursor || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    return {
      items: (response.data.files ?? []).map((file) => ({
        providerFileId: file.id ?? '',
        name: file.name ?? '',
        sizeBytes: String(file.size ?? 0),
        mimeType: file.mimeType ?? 'application/octet-stream',
        modifiedAt: file.modifiedTime ?? null,
      })),
      nextCursor: response.data.nextPageToken ?? null,
    }
  }

  throw new ProviderOperationError(`Unknown storage provider "${account.provider}".`, 'UNKNOWN_PROVIDER')
}

export type ProviderHealth = {
  accountId: string
  provider: string
  ok: boolean
  usedBytes?: string
  totalBytes?: string
  detail?: string
}

/** Non-secret health check: bucket/drive reachable with the stored credentials. */
export async function checkProviderHealth(accountId: string, userId: string): Promise<ProviderHealth> {
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: accountId, userId } })
  if (account.provider === 's3') {
    const config = await getS3ConfigForAccount(account.id, userId)
    const client = createS3Client(config)
    try {
      await withTransientRetry(() => client.send(new HeadBucketCommand({ Bucket: config.bucket })))
      const stored = await prisma.storageAccount.findUnique({ where: { connectedAccountId: account.id } })
      return {
        accountId,
        provider: 's3',
        ok: true,
        usedBytes: stored?.usedBytes.toString(),
        totalBytes: stored?.totalBytes?.toString(),
      }
    } catch (error) {
      const problem = s3Problem(error, config)
      return { accountId, provider: 's3', ok: false, detail: problem.message }
    }
  }
  if (account.provider === 'google_drive') {
    const auth = await getAuthedGoogleClient(account)
    try {
      const about = await withTransientRetry(() =>
        google.drive({ version: 'v3', auth }).about.get({ fields: 'storageQuota(limit,usage)' }),
      )
      return {
        accountId,
        provider: 'google_drive',
        ok: true,
        usedBytes: about.data.storageQuota?.usage ?? undefined,
        totalBytes: about.data.storageQuota?.limit ?? undefined,
      }
    } catch (error) {
      const problem = googleProblem(error)
      return { accountId, provider: 'google_drive', ok: false, detail: problem.message }
    }
  }
  return { accountId, provider: account.provider, ok: false, detail: 'Unknown storage provider.' }
}
