import type { NextFunction, Request, Response } from 'express'
import { env } from '../config/env.js'
import { prisma } from '../config/prisma.js'
import { hashToken } from '../utils/crypto.js'
import { grantsScope, normalizeScopes, type ApiScope } from '../modules/public-api/scopes.js'
import { takeApiKeyToken } from '../modules/public-api/rate-limit.js'
import { canManageResources, effectiveRole, isActive } from '../modules/auth/roles.js'

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

export type ApiKeyReadResult = {
  rawKey: string | null
  problem: 'query' | 'missing' | null
}

/**
 * Reads the key from the Authorization header only. Query-string keys are
 * rejected explicitly: URLs are logged, shared and leaked through Referer.
 * Pure and exported so the rule can be tested without a database.
 */
export function readBearerKey(req: Pick<Request, 'header'> & { query?: Record<string, unknown> }): ApiKeyReadResult {
  const queryKey = typeof req.query?.api_key === 'string' ? req.query.api_key : null
  if (queryKey) return { rawKey: null, problem: 'query' }
  const header = req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return { rawKey: null, problem: 'missing' }
  const rawKey = header.slice(7).trim()
  return rawKey ? { rawKey, problem: null } : { rawKey: null, problem: 'missing' }
}

/**
 * Authenticates an external caller by API key.
 *
 * `scope` is the permission this route needs. When several are passed, any one
 * of them is enough (used by routes that serve both a read and a write use).
 * The signed-URL flow performs its own live key-status/scope check because it
 * carries no Authorization header.
 */
export function requireApiKey(scope: ApiScope | ApiScope[]) {
  const needed = Array.isArray(scope) ? scope : [scope]

  return async (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    try {
      const read = readBearerKey(req)
      if (read.problem === 'query') {
        return res.status(401).json({
          code: 'API_KEY_QUERY_NOT_ALLOWED',
          message: 'API keys must be sent in the Authorization header; query-string keys are not accepted.',
          hint: 'Use "Authorization: Bearer 9d_live_..." and rotate the key if it was ever placed in a URL.',
        })
      }
      if (!read.rawKey) {
        return res.status(401).json({
          code: 'API_KEY_REQUIRED',
          message: 'Send your key as "Authorization: Bearer 9d_live_...".',
          hint: 'Create a key in 9Drive -> API Management.',
        })
      }

      const apiKey = await prisma.apiKey.findUnique({ where: { keyHash: hashToken(read.rawKey) } })

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
        const budget = await takeApiKeyToken(apiKey.id, env.API_RATE_LIMIT_PER_MINUTE, { storage: env.API_RATE_LIMIT_STORAGE })
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

/**
 * Extra gate for API-key routes that can spend an account's storage or change it.
 *
 * Key rows are only creatable by an account that manages resources, but a key
 * outlives a demotion: a student promoted for a week, then demoted, would keep an
 * active key forever. This re-reads the owner from the database on each write so
 * a demoted or deactivated account loses its keys immediately, rather than at
 * the next manual revocation. Read routes skip it - one query per download adds
 * up, and a read-only key cannot damage anything.
 */
export function requireActiveKeyOwner() {
  return async (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id
      if (!userId) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Sign in or send a valid API key.' })
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, role: true, status: true } })
      if (!user || !isActive(user)) {
        return res.status(403).json({ code: 'ACCOUNT_DISABLED', message: 'The account that owns this API key is not active. Re-enable the account or use a different key.' })
      }
      if (!canManageResources(effectiveRole(user))) {
        return res.status(403).json({
          code: 'ROLE_FORBIDDEN',
          message: 'The account that owns this API key may no longer manage storage. Restore its administrator role to use this key for writes.',
          requiredPermission: 'manage_resources',
        })
      }
      return next()
    } catch (error) {
      return next(error)
    }
  }
}
