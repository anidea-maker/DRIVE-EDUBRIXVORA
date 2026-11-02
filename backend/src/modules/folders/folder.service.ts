import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient } from '../google/google.service.js'
import { createAuditLog } from '../../utils/audit.js'

export const defaultFolderColor = '#3b82f6'
export const defaultFolderIconUrl = 'https://api.iconify.design/lucide:folder.svg'

const iconUrlSchema = z.string().url().startsWith('https://api.iconify.design/lucide:').max(2048)
const colorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|text-[a-z]+-[0-9]+)$/).max(64)

export const folderCreateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  color: colorSchema.optional(),
  iconUrl: iconUrlSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
})

export type FolderCreateInput = z.infer<typeof folderCreateSchema>

export const folderSelect = {
  id: true,
  name: true,
  color: true,
  iconUrl: true,
  parentId: true,
  providerFolderId: true,
  createdAt: true,
  updatedAt: true,
} as const

export type FolderSummary = {
  id: string
  name: string
  color: string
  iconUrl: string | null
  parentId: string | null
  providerFolderId: string | null
  createdAt: Date
  updatedAt: Date
}

export function serializeFolder(folder: FolderSummary) {
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    iconUrl: folder.iconUrl,
    parentId: folder.parentId,
    providerFolderId: folder.providerFolderId,
    createdAt: folder.createdAt.toISOString(),
    updatedAt: folder.updatedAt.toISOString(),
  }
}

/**
 * Creates a dashboard folder *and* the matching Google Drive folder when Drive is
 * connected. Extracted so the dashboard and the public API cannot drift apart:
 * a folder made over the API has to be usable from the dashboard and vice versa.
 */
export async function createFolder(userId: string, input: FolderCreateInput): Promise<FolderSummary> {
  const parentFolder = input.parentId
    ? await prisma.folder.findFirstOrThrow({ where: { id: input.parentId, userId, deletedAt: null } })
    : null

  const connectedAccount = await prisma.connectedAccount.findFirst({
    where: { userId, provider: 'google_drive', status: 'connected' },
  })

  let providerFolderId: string | null = null
  if (connectedAccount) {
    try {
      const auth = await getAuthedGoogleClient(connectedAccount)
      const drive = google.drive({ version: 'v3', auth })

      let googleParentId = await ensureGoogleAppFolder(connectedAccount)
      if (parentFolder?.providerFolderId) googleParentId = parentFolder.providerFolderId

      const driveFolder = await drive.files.create({
        requestBody: {
          name: input.name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [googleParentId],
        },
        fields: 'id',
      })
      providerFolderId = driveFolder.data.id ?? null
    } catch (error) {
      // A Drive hiccup must not cost the user the folder: it stays usable for S3
      // uploads and is linked to Drive later by the self-heal on folder listing.
      console.error('Failed to create folder on Google Drive:', error)
    }
  }

  const folder = await prisma.folder.create({
    data: {
      userId,
      name: input.name,
      color: input.color ?? defaultFolderColor,
      iconUrl: input.iconUrl ?? defaultFolderIconUrl,
      parentId: input.parentId ?? null,
      providerFolderId,
      connectedAccountId: connectedAccount?.id ?? null,
    },
    select: folderSelect,
  })
  await createAuditLog(userId, 'CREATE_FOLDER', 'folder', folder.id, { name: folder.name })
  return folder
}
