import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { jsonStringArray, toJsonArrayColumn } from '../../utils/json-column.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireRole } from '../../middleware/role.middleware.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { createAuditLog } from '../../utils/audit.js'
import { ALL_SCOPES, API_SCOPES, normalizeScopes, selectScopes } from '../public-api/scopes.js'

export const apiKeyRouter = Router()
apiKeyRouter.use(requireAuth)
// Creating or revoking a server-to-server credential is an admin operation.
apiKeyRouter.use(requireRole('manage_resources'))

const createSchema = z.object({
  name: z.string().trim().min(1).max(191),
  // Optional: a caller that predates scopes still gets the full storage set,
  // which is what "storage for my other website" needs out of the box.
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
})

function serializeApiKey(apiKey: { id: string; name: string; keyPrefix: string; scopes: unknown; status: string; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date }) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    scopes: jsonStringArray(apiKey.scopes),
    status: apiKey.status,
    lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    expiresAt: apiKey.expiresAt?.toISOString() ?? null,
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
    createdAt: apiKey.createdAt.toISOString(),
  }
}

/**
 * The scopes this deployment understands, so the dashboard offers exactly the
 * permissions the API enforces instead of a hardcoded copy that can drift.
 */
apiKeyRouter.get('/scopes', (_req, res) => {
  return res.json({ scopes: API_SCOPES, defaultScopes: ALL_SCOPES })
})

apiKeyRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const apiKeys = await prisma.apiKey.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } })
    return res.json({ apiKeys: apiKeys.map(serializeApiKey) })
  } catch (error) {
    return next(error)
  }
})

apiKeyRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const chosenScopes = selectScopes(body.scopes)
    if (chosenScopes.length === 0) {
      return res.status(400).json({
        code: 'API_KEY_SCOPES_INVALID',
        message: 'None of the requested scopes exist. Pick at least one of: ' + ALL_SCOPES.join(', ') + '.',
        allowed: ALL_SCOPES,
      })
    }
    const secret = `9d_live_${randomToken(32)}`
    const apiKey = await prisma.apiKey.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        keyPrefix: secret.slice(0, 16),
        keyHash: hashToken(secret),
        scopes: toJsonArrayColumn(chosenScopes),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    })
    return res.status(201).json({ apiKey: serializeApiKey(apiKey), secret })
  } catch (error) {
    return next(error)
  }
})

apiKeyRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    await prisma.apiKey.updateMany({ where: { id: String(req.params.id), userId: req.user!.id, revokedAt: null }, data: { status: 'revoked', revokedAt: new Date() } })
    await createAuditLog(req.user!.id, 'REVOKE_API_KEY', 'api_key', String(req.params.id))
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

/**
 * Rotate the single website key without leaving two live credentials behind.
 * The old row is revoked in the same transaction that creates the replacement,
 * preserving its name, scopes and (if still in the future) expiry. The new full
 * key is returned once and only its hash is stored.
 */
apiKeyRouter.post('/:id/regenerate', async (req: AuthRequest, res, next) => {
  try {
    const id = String(req.params.id)
    const existing = await prisma.apiKey.findFirst({ where: { id, userId: req.user!.id } })
    if (!existing) return res.status(404).json({ code: 'API_KEY_NOT_FOUND', message: 'That API key does not exist.' })
    if (existing.status !== 'active' || existing.revokedAt || (existing.expiresAt && existing.expiresAt <= new Date())) {
      return res.status(409).json({ code: 'API_KEY_NOT_ACTIVE', message: 'Only an active key can be rotated. Create a new key instead.' })
    }

    const secret = `9d_live_${randomToken(32)}`
    const scopes = normalizeScopes(existing.scopes)
    const expiresAt = existing.expiresAt && existing.expiresAt > new Date() ? existing.expiresAt : null
    const rotated = await prisma.$transaction(async (tx) => {
      await tx.apiKey.update({ where: { id }, data: { status: 'revoked', revokedAt: new Date() } })
      return tx.apiKey.create({
        data: {
          userId: req.user!.id,
          name: existing.name,
          keyPrefix: secret.slice(0, 16),
          keyHash: hashToken(secret),
          scopes: toJsonArrayColumn(scopes),
          expiresAt,
        },
      })
    })
    await createAuditLog(req.user!.id, 'REGENERATE_API_KEY', 'api_key', rotated.id, { previousKeyId: id })
    return res.status(201).json({
      apiKey: serializeApiKey(rotated),
      secret,
      note: 'The previous key was revoked. Store this secret now; it is shown once and cannot be retrieved.',
    })
  } catch (error) {
    return next(error)
  }
})
