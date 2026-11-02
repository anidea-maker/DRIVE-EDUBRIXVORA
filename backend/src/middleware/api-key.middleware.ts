import type { NextFunction, Request, Response } from 'express'
import { env } from '../config/env.js'
import { prisma } from '../config/prisma.js'
import { hashToken } from '../utils/crypto.js'
import { grantsScope, normalizeScopes, type ApiScope } from '../modules/public-api/scopes.js'

export type ApiKeyRequest = Request & {
  user?: { id: string; sessionId: string }
  apiKey?: { id: string; scopes: string[] }
}

export const SCOPE_HEADER = 'X-Api-Scopes'

/** Scope id -> the sentence that tells the caller how to fix a 403. */
const SCOPE_FIXES: Partial<Record<ApiScope, string>> = {
  'files:read': 'Create a key with the "Read" scope in 9Drive -> API Management.',
  'files:write': 'Create a key with the "Write" scope in 9Drive -> API Management.',
  'files:delete': 'Create a key with the "Delete" scope in 9Drive -> API Management.',
}

/**
 * Per-key request budget, in memory.
 *
 * An external site in a retry loop can otherwise turn one bug into thousands of
 * database reads and provider calls per minute. Deliberately per-instance and
 * lossy: it protects the service, it is not a billing meter.
 */
const WINDOW_MS = 60_000
const buckets = new Map<string, { count: number; resetAt: number }>()

function takeToken(keyId: string, limit: number) {
  const now = Date.now()
  const bucket = buckets.get(keyId)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(keyId, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true, remaining: limit - 1, resetAt: now + WINDOW_MS }
  }
  bucket.count += 1
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt }
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
}, WINDOW_MS).unref?.()

/**
 * Authenticates an external caller by API key.
 *
 * `scope` is the permission this route needs. When several are passed, any one
 * of them is enough (used by routes that serve both a read and a write use).
 */
export function requireApiKey(scope: ApiScope | ApiScope[]) {
  const needed = Array.isArray(scope) ? scope : [scope]

  return async (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    try {
      const header = req.header('Authorization')
      const queryKey = typeof req.query.api_key === 'string' ? req.query.api_key : null
      if (!header?.startsWith('Bearer ') && !queryKey) {
        return res.status(401).json({
          code: 'API_KEY_REQUIRED',
          message: 'Send your key as "Authorization: Bearer 9d_live_...".',
          hint: 'Create a key in 9Drive -> API Management.',
        })
      }

      const rawKey = header?.startsWith('Bearer ') ? header.slice(7).trim() : queryKey!.trim()
      const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashToken(rawKey) } })

      if (!apiKey) {
        return res.status(401).json({ code: 'API_KEY_INVALID', message: 'This API key does not exist. It may have been revoked, or the value was copied incompletely.' })
      }
      if (apiKey.status !== 'active' || apiKey.revokedAt) {
        return res.status(401).json({ code: 'API_KEY_REVOKED', message: `This API key was revoked${apiKey.revokedAt ? ` on ${apiKey.revokedAt.toISOString()}` : ''}. Create a new key in API Management.` })
      }
      if (apiKey.expiresAt && apiKey.expiresAt <= new Date()) {
        return res.status(401).json({ code: 'API_KEY_EXPIRED', message: `This API key expired on ${apiKey.expiresAt.toISOString()}. Create a new key in API Management.` })
      }

      const scopes = normalizeScopes(apiKey.scopes)
      const allowed = needed.some((candidate) => grantsScope(scopes, candidate))
      if (!allowed) {
        const missing = needed.find((candidate) => !grantsScope(scopes, candidate)) ?? needed[0]
        return res.status(403).json({
          code: 'API_KEY_SCOPE_MISSING',
          message: `This key has [${scopes.join(', ') || 'no scopes'}] but the route needs "${missing}".`,
          hint: SCOPE_FIXES[missing] ?? 'Create a new key with the required scope in API Management.',
          requiredScope: missing,
          keyScopes: scopes,
        })
      }

      if (env.API_RATE_LIMIT_PER_MINUTE > 0) {
        const budget = takeToken(apiKey.id, env.API_RATE_LIMIT_PER_MINUTE)
        res.setHeader('X-RateLimit-Limit', String(env.API_RATE_LIMIT_PER_MINUTE))
        res.setHeader('X-RateLimit-Remaining', String(budget.remaining))
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(budget.resetAt / 1000)))
        if (!budget.allowed) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((budget.resetAt - Date.now()) / 1000))))
          return res.status(429).json({
            code: 'RATE_LIMITED',
            message: `This key allows ${env.API_RATE_LIMIT_PER_MINUTE} requests per minute. Retry after the window resets.`,
          })
        }
      }

      req.user = { id: apiKey.userId, sessionId: `api-key:${apiKey.id}` }
      req.apiKey = { id: apiKey.id, scopes }
      // Tell the caller which permissions are actually in force, so an old key
      // that cannot read is diagnosable from the response of any request.
      res.setHeader(SCOPE_HEADER, scopes.join(','))

      // One write per minute is enough to answer "was this key used?" and keeps a
      // busy integration from turning every request into a row update.
      const stale = !apiKey.lastUsedAt || Date.now() - apiKey.lastUsedAt.getTime() > 60_000
      if (stale) await prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)

      return next()
    } catch (error) {
      return next(error)
    }
  }
}
