import type { Request } from 'express'
import { env } from '../../config/env.js'

/**
 * Absolute origin this deployment answers on, used to build links that leave the
 * building: a share URL embedded in someone else's website, `next`/`Location`
 * headers, and the download URLs handed to an API client.
 *
 * `PUBLIC_BASE_URL` overrides it for deployments behind a proxy that rewrites the
 * Host header; otherwise the request's own origin is correct by construction and
 * does not depend on FRONTEND_URL being set to the right thing.
 */
export function publicBaseUrl(req: Request) {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  return `${req.protocol}://${req.get('host')}`
}

export function absoluteUrl(req: Request, path: string) {
  return `${publicBaseUrl(req)}${path.startsWith('/') ? path : `/${path}`}`
}

type FileRecord = {
  id: string
  name: string
  mimeType: string
  sizeBytes: bigint | number
  provider: string
  folderId: string | null
  status: string
  createdAt: Date
  updatedAt: Date
  deletedAt?: Date | null
  connectedAccountId?: string
  folder?: { id: string; name: string } | null
  connectedAccount?: { id: string; provider: string; email?: string | null } | null
}

/**
 * The wire shape of a file.
 *
 * `sizeBytes` is a string because these are 5 GB-capable values and JavaScript
 * numbers lose precision above 2^53 - a client that parses it as a number gets a
 * silently wrong size in its own storage accounting.
 */
export function apiFile(req: Request, file: FileRecord) {
  const contentPath = `/api/v1/files/${file.id}/content`
  const downloadPath = `/api/v1/files/${file.id}/download`
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes.toString(),
    provider: file.provider,
    folderId: file.folderId,
    folder: file.folder ? { id: file.folder.id, name: file.folder.name } : null,
    accountId: file.connectedAccountId ?? file.connectedAccount?.id ?? null,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
    deletedAt: file.deletedAt ? file.deletedAt.toISOString() : null,
    // Authenticated endpoints - a site embedding an <img> should mint a share link
    // instead, so the key never reaches the browser.
    urls: {
      content: absoluteUrl(req, contentPath),
      download: absoluteUrl(req, downloadPath),
    },
  }
}

type FolderRecord = {
  id: string
  name: string
  parentId: string | null
  color: string
  iconUrl?: string | null
  providerFolderId?: string | null
  createdAt: Date
  updatedAt: Date
}

export function apiFolder(req: Request, folder: FolderRecord) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    color: folder.color,
    iconUrl: folder.iconUrl ?? null,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
    urls: { files: absoluteUrl(req, `/api/v1/files?folderId=${folder.id}`) },
  }
}

/** Mime types the dashboard groups as "images" etc., reused by `?kind=`. */
export const KIND_FILTERS: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif'],
  video: ['video/mp4', 'video/mpeg', 'video/ogg', 'video/quicktime', 'video/webm'],
  audio: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm'],
  pdf: ['application/pdf'],
  doc: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'text/markdown'],
  archive: ['application/zip', 'application/x-rar-compressed', 'application/x-tar', 'application/x-7z-compressed', 'application/gzip'],
}
