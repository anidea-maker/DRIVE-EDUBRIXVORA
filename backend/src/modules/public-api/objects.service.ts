import { google } from 'googleapis'
import { randomUUID } from 'node:crypto'
import type { File, Prisma } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'
import { buildS3ObjectKey, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { deleteProviderFile, verifyProviderFile, ProviderOperationError, type Availability, type ProviderFileRef, type ProviderMetadata } from '../storage/provider-operations.js'
import { selectAccount, syncQuotaInBackground } from '../uploads/upload.routes.js'
import {
  baseName,
  buildObjectListWhere,
  encodeContinuation,
  etagOf,
  hashingStream,
  type Continuation,
  type ListEntry,
  type ListResult,
  type ObjectListFilters,
  type ObjectProblem,
} from './objects.shared.js'
import { safeStorageProblem, type SafeProblem } from './safe-errors.js'

// Re-exported so callers keep importing the object surface from one place.
export {
  MAX_OBJECT_KEY_LENGTH,
  baseName,
  buildObjectListWhere,
  buildUniqueObjectKey,
  decodeContinuation,
  encodeContinuation,
  etagOf,
  hashingStream,
  objectKeyMessage,
  objectKeyProblem,
  safeInlineMimeType,
  safeObjectFileName,
  type Continuation,
  type ListEntry,
  type ListResult,
  type ObjectListFilters,
  type ObjectProblem,
} from './objects.shared.js'

export type ObjectRow = File & { connectedAccount: { id: string; provider: string } }

export type PutObjectResult =
  | { ok: true; file: File; created: boolean; providerFileId: string }
  | { ok: false; code: string; message: string }

export function findObject(userId: string, key: string) {
  return prisma.file.findFirst({
    where: { userId, objectKey: key, status: 'active' },
    include: { connectedAccount: true },
  })
}

/**
 * A freshly uploaded object is only `active` after the provider confirms it
 * exists. Three short attempts absorb an eventually-consistent S3-compatible
 * provider; an auth/permission failure is reported immediately. No raw provider
 * message is stored or returned.
 */
async function assertProviderFileAvailable(ref: ProviderFileRef): Promise<ProviderMetadata> {
  let last: ProviderMetadata = { availability: 'unknown' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await verifyProviderFile(ref)
    if (last.availability === 'available') return last
    if (last.availability === 'inaccessible') break
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
  }
  throw new ProviderOperationError(
    'The connected storage provider did not confirm the uploaded object.',
    'UPLOAD_VERIFICATION_FAILED',
    last.availability as Availability,
  )
}

function drain(body: NodeJS.ReadableStream) {
  const stream = body as NodeJS.ReadableStream & { resume?: () => void; unpipe?: () => void }
  stream.unpipe?.()
  stream.resume?.()
}

/**
 * Writes one object.
 *
 * Order matters: the new bytes land at a *new* provider key / Drive file before
 * the database row is repointed and before any old object is removed, so a
 * failed upload leaves the previous version readable instead of losing both.
 * The declared byte count and a provider HEAD/get are checked before success is
 * reported; a retry with the same key replaces the row rather than creating a
 * duplicate. An overwrite stays on the account recorded on that row: there is
 * no silent provider migration.
 */
export async function putObject(input: {
  userId: string
  key: string
  body: NodeJS.ReadableStream
  sizeBytes: bigint
  mimeType: string
  source: 'api' | 'signed-url'
  /** Optional explicit storage provider selection for the resource API. */
  provider?: 'google_drive' | 's3'
}): Promise<PutObjectResult> {
  const { userId, key, body, sizeBytes, mimeType, provider } = input
  const existing = await prisma.file.findFirst({ where: { userId, objectKey: key }, include: { connectedAccount: true } })
  const name = baseName(key)
  const existingProvider = existing?.connectedAccount?.provider

  if (existing && provider && existingProvider !== provider) {
    drain(body)
    const problem = safeStorageProblem({ code: 'OBJECT_PROVIDER_MIGRATION_UNSUPPORTED' })
    return { ok: false as const, code: problem.code, message: problem.message }
  }

  let account
  if (existing?.connectedAccountId) {
    // Overwrite is pinned to the recorded account. A disconnected/full account
    // returns a clear error instead of silently moving bytes elsewhere.
    account = await selectAccount(userId, sizeBytes, undefined, existing.connectedAccountId, provider ?? existingProvider)
    if (!account) {
      drain(body)
      const problem = safeStorageProblem({ code: 'STORAGE_ACCOUNT_UNAVAILABLE' })
      return { ok: false as const, code: problem.code, message: problem.message }
    }
  } else {
    account = await selectAccount(userId, sizeBytes, undefined, null, provider)
    if (!account) {
      drain(body)
      const problem = safeStorageProblem({ code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE' })
      return { ok: false as const, code: problem.code, message: problem.message }
    }
  }

  const session = await prisma.uploadSession.create({
    data: {
      userId,
      targetConnectedAccountId: account.id,
      folderId: null,
      fileName: name,
      mimeType,
      sizeBytes,
      status: 'uploading',
    },
  })

  const fail = async (problem: SafeProblem): Promise<Extract<PutObjectResult, { ok: false }>> => {
    await prisma.uploadSession
      .update({ where: { id: session.id }, data: { status: 'failed', errorMessage: problem.code } })
      .catch(() => undefined)
    return { ok: false as const, code: problem.code, message: problem.message }
  }

  // The row is created (or reused) first because the S3 object key contains its id.
  const row = existing ?? (await prisma.file.create({
    data: {
      userId,
      connectedAccountId: account.id,
      provider: account.provider,
      providerFileId: '',
      name,
      mimeType,
      sizeBytes,
      objectKey: key,
      status: 'uploading',
    },
  }))

  const hashing = hashingStream()
  /**
   * The Transform both counts/MD5s the bytes and is what the provider reads.
   * Without piping the request into it, an object upload would write an empty
   * stream forever - so this connection is the upload, not an optional detail.
   */
  const source = body as NodeJS.ReadableStream & { on?: (event: string, listener: (error: unknown) => void) => void }
  source.on?.('error', (streamError) => {
    hashing.stream.destroy(streamError instanceof Error ? streamError : new Error(String(streamError)))
  })
  source.pipe(hashing.stream)
  /** Set as soon as the provider has bytes, so a failed upload can clean up. */
  let createdProviderRef: ProviderFileRef | null = null

  try {
    let providerFileId = ''
    let uploadedName = name
    let uploadedMimeType = mimeType

    if (account.provider === 's3') {
      const config = await getS3ConfigForAccount(account.id, userId)
      // A unique key per attempt keeps the previous object readable until the
      // database row is repointed; overwriting the old key in place would lose
      // both versions if the network died midway.
      const providerKey = buildS3ObjectKey(config, userId, `${row.id}-${randomUUID()}`, name)
      createdProviderRef = {
        provider: 's3',
        providerFileId: providerKey,
        connectedAccountId: account.id,
        userId,
        name,
        mimeType,
      }
      await uploadS3Object(config, providerKey, hashing.stream, mimeType)
      providerFileId = providerKey
    } else {
      const auth = await getAuthedGoogleClient(account)
      const drive = google.drive({ version: 'v3', auth })
      const parentId = await ensureGoogleAppFolder(account)
      const uploaded = await drive.files.create({
        requestBody: { name, parents: [parentId] },
        media: { mimeType, body: hashing.stream },
        fields: 'id,name,mimeType',
        supportsAllDrives: true,
      })
      providerFileId = uploaded.data.id ?? ''
      uploadedName = uploaded.data.name ?? name
      uploadedMimeType = uploaded.data.mimeType ?? mimeType
      createdProviderRef = {
        provider: 'google_drive',
        providerFileId,
        connectedAccountId: account.id,
        userId,
        name: uploadedName,
        mimeType: uploadedMimeType,
      }
    }

    const { checksum, bytes } = hashing.result()
    if (BigInt(bytes) !== sizeBytes) {
      throw new ProviderOperationError('The received byte count did not match Content-Length.', 'UPLOAD_SIZE_MISMATCH')
    }
    if (!providerFileId) throw new ProviderOperationError('The storage provider returned no file identifier.', 'UPLOAD_FAILED')

    const verification = await assertProviderFileAvailable({
      provider: account.provider,
      providerFileId,
      connectedAccountId: account.id,
      userId,
      name: uploadedName,
      mimeType: uploadedMimeType,
      sizeBytes,
    })

    const file = await prisma.file.update({
      where: { id: row.id },
      data: {
        connectedAccountId: account.id,
        provider: account.provider,
        providerFileId,
        name: uploadedName,
        mimeType: uploadedMimeType,
        sizeBytes: verification.sizeBytes ?? sizeBytes,
        checksum,
        objectKey: key,
        status: 'active',
        deletedAt: null,
      },
    })

    // Only now is the superseded object safe to remove. A failure here is logged
    // as a code, not reported as an upload failure: the new file is readable.
    if (existing && existing.providerFileId && existing.providerFileId !== providerFileId) {
      await removeProviderObject(existing.connectedAccount.provider, existing).catch((error) => {
        const problem = safeStorageProblem(error, 'DELETE_FAILED')
        console.error(`[objects] could not remove the superseded object: ${problem.code}`)
      })
    }
    createdProviderRef = null

    await completeSession(session.id)
    await audit(userId, key, sizeBytes, input.source)
    if (account.provider === 's3') syncS3Quota(account.id).catch(() => undefined)
    else syncQuotaInBackground(account.id, session.id)
    return { ok: true as const, file, created: !existing, providerFileId }
  } catch (error) {
    const problem = safeStorageProblem(error, 'UPLOAD_FAILED')
    drain(source)
    if (createdProviderRef) {
      await deleteProviderFile(createdProviderRef).catch((cleanupError) => {
        const cleanupProblem = safeStorageProblem(cleanupError, 'DELETE_FAILED')
        console.error(`[objects] could not clean up a failed upload: ${cleanupProblem.code}`)
      })
    }
    // A brand-new row has nothing behind it; mark it gone so the key stays usable.
    if (!existing) {
      await prisma.file.update({ where: { id: row.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
    } else {
      await prisma.file.update({ where: { id: row.id }, data: { status: existing.status } }).catch(() => undefined)
    }
    return fail(problem)
  }
}

async function completeSession(sessionId: string) {
  await prisma.uploadSession
    .update({ where: { id: sessionId }, data: { status: 'completed', completedAt: new Date() } })
    .catch(() => undefined)
}

async function audit(userId: string, key: string, sizeBytes: bigint, source: 'api' | 'signed-url') {
  await createAuditLog(userId, 'PUT_OBJECT', 'file', key, { key, size: sizeBytes.toString(), source }).catch(() => undefined)
}

type ProviderObject = {
  providerFileId: string
  connectedAccountId: string
  connectedAccount: { id: string; provider: string }
}

/** Deletes the bytes at the provider. Callers decide whether a failure matters. */
export async function removeProviderObject(provider: string, file: ProviderObject) {
  const resolved = file.connectedAccount.provider || provider
  await deleteProviderFile({
    provider: resolved,
    providerFileId: file.providerFileId,
    connectedAccountId: file.connectedAccountId,
  })
}

/** Deletes an object for good - S3 has no trash, and `DELETE` is idempotent. */
export async function deleteObject(userId: string, key: string) {
  const file = await prisma.file.findFirst({ where: { userId, objectKey: key }, include: { connectedAccount: true } })
  if (!file) return { deleted: false as const }
  try {
    await removeProviderObject(file.connectedAccount.provider, file)
  } catch (error) {
    // A trashed row still occupies the key, so the object would come back on the
    // next GET. Report instead of pretending the delete worked.
    const problem = safeStorageProblem(error, 'DELETE_FAILED')
    return { deleted: false as const, code: problem.code, message: problem.message }
  }
  await prisma.file.delete({ where: { id: file.id } })
  await createAuditLog(userId, 'DELETE_OBJECT', 'file', key, { key }).catch(() => undefined)
  if (file.connectedAccount.provider === 's3') {
    await syncS3Quota(file.connectedAccountId).catch(() => undefined)
  }
  return { deleted: true as const }
}

/* ------------------------------- listing --------------------------------- */

/**
 * Lists objects the way S3 does: `prefix` narrows, `delimiter` collapses the rest
 * of the path into common prefixes (this is how a console renders "folders").
 * `q` searches name/key and indexed metadata; `checksum` supports content-based
 * duplicate detection. Pagination is keyset-style by object key.
 */
export async function listObjects(input: {
  userId: string
  prefix: string
  delimiter: string | null
  maxKeys: number
  continuation: Continuation | null
  q?: string
  checksum?: string
  mimeType?: string
  where?: Record<string, unknown>
}): Promise<ListResult> {
  const { userId, prefix, delimiter, maxKeys, continuation } = input
  const where = (input.where ?? buildObjectListWhere({
    userId,
    prefix,
    continuation,
    q: input.q,
    checksum: input.checksum,
    mimeType: input.mimeType,
  })) as Prisma.FileWhereInput
  // A page of `maxKeys` can be filled by fewer rows (a delimiter collapses many
  // keys into one prefix), so read a multiple and stop when the page is full.
  const scanLimit = maxKeys * 4 + 1
  const rows = await prisma.file.findMany({
    where,
    orderBy: { objectKey: 'asc' },
    take: scanLimit,
    select: {
      objectKey: true,
      name: true,
      sizeBytes: true,
      mimeType: true,
      checksum: true,
      createdAt: true,
      updatedAt: true,
      resourceMetadata: true,
    },
  })

  const objects: ListEntry[] = []
  const prefixes: string[] = []
  let lastKey = continuation?.after ?? ''
  let isTruncated = false
  let skippedPrefix = continuation?.skippedPrefix ?? null

  for (const row of rows) {
    const key = row.objectKey as string
    if (objects.length + prefixes.length >= maxKeys) {
      isTruncated = true
      break
    }

    let common: string | null = null
    if (delimiter) {
      const rest = key.slice(prefix.length)
      const index = rest.indexOf(delimiter)
      if (index >= 0) common = prefix + rest.slice(0, index + delimiter.length)
    }

    if (common !== null) {
      if (common === skippedPrefix) continue
      if (!prefixes.includes(common)) prefixes.push(common)
    } else {
      objects.push({
        key,
        name: row.name,
        sizeBytes: row.sizeBytes.toString(),
        mimeType: row.mimeType,
        checksum: row.checksum,
        createdAt: row.createdAt.toISOString(),
        lastModified: row.updatedAt.toISOString(),
        etag: row.checksum ? `"${row.checksum}"` : null,
        metadata: row.resourceMetadata ?? null,
      })
    }
    lastKey = key
    skippedPrefix = common
  }

  // The scan hit its cap before the page filled: there is at least one more row,
  // so hand back a continuation rather than silently truncating the listing.
  if (rows.length === scanLimit) isTruncated = true

  return {
    objects,
    prefixes,
    isTruncated,
    nextContinuationToken: isTruncated ? encodeContinuation({ after: lastKey, skippedPrefix }) : null,
    scanned: rows.length,
  }
}
