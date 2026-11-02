import { google } from 'googleapis'
import type { File } from '@prisma/client'
import { prisma } from '../../config/prisma.js'
import { createAuditLog } from '../../utils/audit.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'
import { buildS3ObjectKey, deleteS3Object, getS3ConfigForAccount, syncS3Quota, uploadS3Object } from '../s3/s3.service.js'
import { selectAccount, syncQuotaInBackground } from '../uploads/upload.routes.js'
import {
  baseName,
  encodeContinuation,
  etagOf,
  hashingStream,
  type Continuation,
  type ListEntry,
  type ListResult,
  type ObjectProblem,
} from './objects.shared.js'

// Re-exported so callers keep importing the object surface from one place.
export {
  MAX_OBJECT_KEY_LENGTH,
  baseName,
  decodeContinuation,
  encodeContinuation,
  etagOf,
  hashingStream,
  objectKeyMessage,
  objectKeyProblem,
  type Continuation,
  type ListEntry,
  type ListResult,
  type ObjectProblem,
} from './objects.shared.js'

export type ObjectRow = File & { connectedAccount: { id: string; provider: string } }

export function findObject(userId: string, key: string) {
  return prisma.file.findFirst({
    where: { userId, objectKey: key, status: 'active' },
    include: { connectedAccount: true },
  })
}

/**
 * Writes one object.
 *
 * Order matters: the new bytes land at the provider *before* the database row is
 * repointed and before any old object is removed, so a failed upload leaves the
 * previous version readable instead of losing both.
 */
export async function putObject(input: {
  userId: string
  key: string
  body: NodeJS.ReadableStream
  sizeBytes: bigint
  mimeType: string
  source: 'api' | 'signed-url'
}) {
  const { userId, key, body, sizeBytes, mimeType } = input
  const existing = await prisma.file.findFirst({ where: { userId, objectKey: key }, include: { connectedAccount: true } })
  const name = baseName(key)

  // Prefer the account that already holds this key, so an overwrite stays put;
  // fall back to normal routing when that account is full or gone.
  const pinned = existing?.connectedAccount?.status === 'connected' ? existing.connectedAccountId : undefined
  const account = (pinned ? await selectAccount(userId, sizeBytes, undefined, pinned) : null)
    ?? (await selectAccount(userId, sizeBytes))
  if (!account) {
    return {
      ok: false as const,
      code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE' as const,
      message: 'No connected storage account has room for this object. Connect a bucket in Settings, or free up space.',
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

  const fail = async (message: string) => {
    await prisma.uploadSession
      .update({ where: { id: session.id }, data: { status: 'failed', errorMessage: message } })
      .catch(() => undefined)
    return { ok: false as const, code: 'UPLOAD_FAILED' as const, message }
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

  try {
    if (account.provider === 's3') {
      const config = await getS3ConfigForAccount(account.id, userId)
      const providerKey = buildS3ObjectKey(config, userId, row.id, name)
      await uploadS3Object(config, providerKey, hashing.stream, mimeType)
      const { checksum } = hashing.result()
      const file = await prisma.file.update({
        where: { id: row.id },
        data: {
          connectedAccountId: account.id,
          provider: 's3',
          providerFileId: providerKey,
          name,
          mimeType,
          sizeBytes,
          checksum,
          objectKey: key,
          status: 'active',
          deletedAt: null,
        },
      })

      // Same account: the put landed on the same provider key, which is the
      // overwrite. A different account means the old copy has to be removed.
      if (existing && existing.connectedAccountId !== account.id) {
        await removeProviderObject(existing.connectedAccount.provider, existing).catch((error) => {
          console.error('[objects] could not remove the superseded object:', error instanceof Error ? error.message : error)
        })
      }

      await completeSession(session.id)
      await audit(userId, key, sizeBytes, input.source)
      syncS3Quota(account.id).catch(() => undefined)
      return { ok: true as const, file, created: !existing }
    }

    const auth = await getAuthedGoogleClient(account)
    const drive = google.drive({ version: 'v3', auth })
    const parentId = await ensureGoogleAppFolder(account)
    const uploaded = await drive.files.create({
      requestBody: { name, parents: [parentId] },
      media: { mimeType, body: hashing.stream },
      fields: 'id,name,mimeType',
    })
    const { checksum } = hashing.result()

    const file = await prisma.file.update({
      where: { id: row.id },
      data: {
        connectedAccountId: account.id,
        provider: 'google_drive',
        providerFileId: uploaded.data.id ?? '',
        name: uploaded.data.name ?? name,
        mimeType: uploaded.data.mimeType ?? mimeType,
        sizeBytes,
        checksum,
        objectKey: key,
        status: 'active',
        deletedAt: null,
      },
    })

    // Drive always creates a new file, so the superseded one is never overwritten.
    if (existing) {
      await removeProviderObject(existing.connectedAccount.provider, existing).catch((error) => {
        console.error('[objects] could not remove the superseded Drive file:', error instanceof Error ? error.message : error)
      })
    }

    await completeSession(session.id)
    await audit(userId, key, sizeBytes, input.source)
    syncQuotaInBackground(account.id, session.id)
    return { ok: true as const, file, created: !existing }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The storage provider refused the upload.'
    // A brand-new row has nothing behind it; mark it gone so the key stays usable.
    if (!existing) {
      await prisma.file.update({ where: { id: row.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
    } else {
      await prisma.file.update({ where: { id: row.id }, data: { status: existing.status } }).catch(() => undefined)
    }
    return fail(message)
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
  if (provider === 's3' || file.connectedAccount.provider === 's3') {
    await deleteS3Object(file)
    return
  }
  const account = await prisma.connectedAccount.findUniqueOrThrow({ where: { id: file.connectedAccount.id } })
  const auth = await getAuthedGoogleClient(account)
  await google.drive({ version: 'v3', auth }).files.delete({ fileId: file.providerFileId })
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
    return { deleted: false as const, message: error instanceof Error ? error.message : 'The storage provider refused the delete.' }
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
 *
 * Pagination is by the last raw row consumed, plus the one common prefix that may
 * have been partially read. Anything more elaborate would have to re-scan.
 */
export async function listObjects(input: {
  userId: string
  prefix: string
  delimiter: string | null
  maxKeys: number
  continuation: Continuation | null
}): Promise<ListResult> {
  const { userId, prefix, delimiter, maxKeys, continuation } = input
  // A page of `maxKeys` can be filled by fewer rows (a delimiter collapses many
  // keys into one prefix), so read a multiple and stop when the page is full.
  const scanLimit = maxKeys * 4 + 1
  const rows = await prisma.file.findMany({
    where: {
      userId,
      status: 'active',
      objectKey: { not: null, ...(prefix ? { startsWith: prefix } : {}), ...(continuation ? { gt: continuation.after } : {}) },
    },
    orderBy: { objectKey: 'asc' },
    take: scanLimit,
    select: { objectKey: true, sizeBytes: true, updatedAt: true, checksum: true, mimeType: true },
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
        sizeBytes: row.sizeBytes.toString(),
        lastModified: row.updatedAt.toISOString(),
        etag: row.checksum ? `"${row.checksum}"` : null,
        mimeType: row.mimeType,
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
