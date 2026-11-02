import type { Request } from 'express'
import { putObject } from '../public-api/objects.service.js'
import { mintResourceUrl, type MintedUrl } from '../resources/resource-urls.js'
import type { StorageProviderName } from '../resources/resource.service.js'
import {
  checkProviderHealth,
  deleteProviderFile,
  listProviderPage,
  openProviderReadStream,
  verifyProviderFile,
  type ProviderFileRef,
  type ProviderHealth,
  type ProviderListPage,
  type ProviderMetadata,
} from './provider-operations.js'

/**
 * Common storage interface.
 *
 * Both adapters expose the same operations, so the resource API never branches
 * on `google_drive` vs `s3` for reads, writes, previews or health. The existing
 * routing policy still chooses an account with enough capacity; `provider` is
 * an optional explicit choice for an administrator upload.
 *
 * The implementations are thin wrappers around the provider services that
 * already exist in this project - no second copy of an upload path, no
 * duplicated cloud credentials, and no provider credentials in a response.
 */
export interface StorageAdapter {
  provider: StorageProviderName
  upload_file(input: {
    userId: string
    key: string
    body: NodeJS.ReadableStream
    sizeBytes: bigint
    mimeType: string
    source: 'api' | 'signed-url'
  }): Promise<{ ok: boolean; fileId?: string; providerFileId?: string; code?: string; message?: string }>
  get_file_metadata(file: ProviderFileRef): Promise<ProviderMetadata>
  list_files(input: { accountId: string; userId: string; cursor?: string | null; limit?: number }): Promise<ProviderListPage>
  get_preview_url(req: Request, file: { id: string; userId: string; objectKey: string | null }, ttlSeconds?: number): Promise<MintedUrl>
  get_download_url(req: Request, file: { id: string; userId: string; objectKey: string | null }, ttlSeconds?: number): Promise<MintedUrl>
  open_read_stream(file: ProviderFileRef, range?: string, purpose?: 'preview' | 'download'): ReturnType<typeof openProviderReadStream>
  delete_file(file: ProviderFileRef): Promise<void>
  check_storage_health(accountId: string, userId: string): Promise<ProviderHealth>
}

function createAdapter(provider: StorageProviderName): StorageAdapter {
  return {
    provider,
    async upload_file(input) {
      const result = await putObject({ ...input, provider })
      if (!result.ok) return { ok: false, code: result.code, message: result.message }
      return { ok: true, fileId: result.file.id, providerFileId: result.providerFileId }
    },
    get_file_metadata(file) {
      return verifyProviderFile(file)
    },
    list_files(input) {
      return listProviderPage(input)
    },
    get_preview_url(req, file, ttlSeconds) {
      return mintResourceUrl(req, file, { download: false, ttlSeconds })
    },
    get_download_url(req, file, ttlSeconds) {
      return mintResourceUrl(req, file, { download: true, ttlSeconds })
    },
    open_read_stream(file, range, purpose) {
      return openProviderReadStream(file, range, purpose)
    },
    delete_file(file) {
      return deleteProviderFile(file)
    },
    check_storage_health(accountId, userId) {
      return checkProviderHealth(accountId, userId)
    },
  }
}

export const googleDriveAdapter = createAdapter('google_drive')
export const s3Adapter = createAdapter('s3')

export function getStorageAdapter(provider: string): StorageAdapter {
  if (provider === 'google_drive') return googleDriveAdapter
  if (provider === 's3') return s3Adapter
  throw new Error(`Unknown storage provider "${provider}".`)
}
