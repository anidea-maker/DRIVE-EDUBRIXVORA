import type { PrismaClient } from '@prisma/client'
import { env } from '../../config/env.js'

/**
 * One storage status shape shared by every public/health endpoint.
 *
 * The Edvanta admin panel shows "Storage status has not been reported by the API
 * yet." when its API response has no `storage` object. 9Drive must therefore
 * report the field on *every* endpoint a consumer might use for status, and
 * `reported` must stay true even when a provider is degraded or capacity is
 * unknown. No credentials, emails, bucket names or object keys are included.
 */
export type StorageReport = {
  status: 'connected' | 'degraded' | 'unavailable'
  provider: '9drive'
  configured: '9drive'
  reported: true
  persistence: 'Persistent'
  capacity: {
    reported: boolean
    usedBytes: string
    totalBytes: string | null
    availableBytes: string | null
    fileCapRemaining: string | null
    note: string
  }
  accounts: {
    connected: number
    googleDrive: number
    s3: number
  }
  upload: {
    available: boolean
    endpoint: string
    alternativeEndpoint: string
    method: 'POST'
    requiredScope: 'files:write'
    maxBytes: string
    reason: string | null
  }
  appRecords: string
  display: {
    storageProvider: '9drive'
    storageProviderNote: string
    configured: '9drive'
    fileCapRemaining: string
    persistence: 'Persistent'
    appRecords: string
    uploadEndpoint: string
    uploadAvailable: boolean
  }
  checkedAt: string
  note: string
}

export type StorageReportInput = {
  connectedAccounts?: number
  googleDriveAccounts?: number
  s3Accounts?: number
  usedBytes?: bigint
  totalBytes?: bigint | null
  capacityReported?: boolean
  degraded?: boolean
  unavailable?: boolean
  checkedAt?: string
  note?: string
  maxUploadBytes?: number | bigint
}

/**
 * What the database actually holds. It is shown on another site's admin panel,
 * so it must describe this deployment: file bytes live at Google Drive/S3, and
 * Turso/libSQL only ever stores accounts, file metadata and the resource registry.
 */
const APP_RECORDS = 'Turso (libSQL) — accounts, file metadata & registry, not file bytes'
const PROVIDER_NOTE = '9drive is the only destination for new file bytes'

export function buildStorageReport(input: StorageReportInput = {}): StorageReport {
  const usedBytes = input.usedBytes ?? 0n
  const totalBytes = input.totalBytes ?? null
  const capacityReported = input.capacityReported === true && totalBytes !== null
  const availableBytes = capacityReported && totalBytes !== null
    ? (totalBytes > usedBytes ? totalBytes - usedBytes : 0n)
    : null
  const fileCapRemaining = capacityReported && availableBytes !== null
    ? availableBytes.toString()
    : null
  const status: StorageReport['status'] = input.unavailable
    ? 'unavailable'
    : input.degraded
      ? 'degraded'
      : 'connected'
  const checkedAt = input.checkedAt ?? new Date().toISOString()
  const fileCapLabel = capacityReported && fileCapRemaining !== null
    ? `${fileCapRemaining} bytes`
    : 'Capacity not reported'
  const connected = input.connectedAccounts ?? 0
  const uploadAvailable = status === 'connected' && connected > 0
  const uploadReason = uploadAvailable
    ? null
    : status === 'unavailable'
      ? 'The storage registry could not be read; uploads cannot be routed yet.'
      : connected === 0
        ? 'No connected storage account is available for this API key owner.'
        : 'Storage is degraded; uploads are paused until a provider is healthy.'
  const maxBytes = (input.maxUploadBytes ?? env.MAX_UPLOAD_BYTES).toString()

  return {
    status,
    provider: '9drive',
    configured: '9drive',
    reported: true,
    persistence: 'Persistent',
    capacity: {
      reported: capacityReported,
      usedBytes: usedBytes.toString(),
      totalBytes: totalBytes !== null ? totalBytes.toString() : null,
      availableBytes: availableBytes !== null ? availableBytes.toString() : null,
      fileCapRemaining,
      note: capacityReported
        ? 'Connected accounts report a quota; availableBytes is the current headroom.'
        : 'At least one connected account does not report a quota, so capacity stays unknown rather than looking unlimited.',
    },
    accounts: {
      connected,
      googleDrive: input.googleDriveAccounts ?? 0,
      s3: input.s3Accounts ?? 0,
    },
    upload: {
      available: uploadAvailable,
      endpoint: '/api/v1/resources',
      alternativeEndpoint: '/api/v1/files',
      method: 'POST',
      requiredScope: 'files:write',
      maxBytes,
      reason: uploadReason,
    },
    appRecords: APP_RECORDS,
    display: {
      storageProvider: '9drive',
      storageProviderNote: PROVIDER_NOTE,
      configured: '9drive',
      fileCapRemaining: fileCapLabel,
      persistence: 'Persistent',
      appRecords: APP_RECORDS,
      uploadEndpoint: '/api/v1/resources',
      uploadAvailable,
    },
    checkedAt,
    note: input.note ?? (capacityReported
      ? '9Drive is configured and reporting storage status.'
      : '9Drive is configured and reporting storage status; provider capacity is not reported.'),
  }
}

/** Cheap DB read for public status endpoints; never contacts a cloud provider. */
export async function readStorageReport(prisma: PrismaClient): Promise<StorageReport> {
  try {
    const accounts = await prisma.connectedAccount.findMany({
      where: { status: 'connected' },
      select: {
        provider: true,
        storageAccount: { select: { totalBytes: true, usedBytes: true } },
      },
      take: 500,
    })
    let usedBytes = 0n
    let totalBytes = 0n
    let capacityReported = accounts.length > 0
    let googleDriveAccounts = 0
    let s3Accounts = 0
    for (const account of accounts) {
      if (account.provider === 'google_drive') googleDriveAccounts += 1
      if (account.provider === 's3') s3Accounts += 1
      usedBytes += account.storageAccount?.usedBytes ?? 0n
      const quota = account.storageAccount?.totalBytes
      if (quota === null || quota === undefined) capacityReported = false
      else totalBytes += quota
    }
    return buildStorageReport({
      connectedAccounts: accounts.length,
      googleDriveAccounts,
      s3Accounts,
      usedBytes,
      totalBytes: capacityReported ? totalBytes : null,
      capacityReported,
      degraded: accounts.length === 0,
      note: accounts.length === 0
        ? 'No storage account is connected yet; 9Drive is configured but cannot accept file bytes.'
        : undefined,
    })
  } catch {
    return buildStorageReport({
      unavailable: true,
      note: 'The storage registry could not be read; 9Drive is reporting an unavailable status instead of leaving it unreported.',
    })
  }
}

/** Wrap the report in the fields a status panel usually checks first. */
export function storageStatusResponse(report: StorageReport) {
  return {
    storage: report,
    storageStatus: report.status,
    storageReported: report.reported,
    reported: true,
  }
}
