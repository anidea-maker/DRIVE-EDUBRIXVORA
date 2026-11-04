import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { verifyAccessToken } from '../utils/jwt.js'

export type AuthRequest = Request & {
  user?: { id: string; sessionId: string }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' })
    const payload = verifyAccessToken(header.slice(7))
    const session = await prisma.userSession.findUnique({ where: { id: payload.sid } })
    if (!session || session.revokedAt || session.expiresAt < new Date()) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expired.' })
    req.user = { id: payload.sub, sessionId: payload.sid }
    return next()
  } catch {
    return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
  }
}

/**
 * Attaches `req.user` when a valid bearer token is present, and continues
 * silently otherwise.
 *
 * For pages that are readable by anyone but personalise when signed in - the
 * Coming Soon list shows a vote count to a visitor and their own vote state to a
 * member. Using `requireAuth` would lock the page; not using any auth would make
 * every response anonymous, so the same page would look different after signing
 * in with no way to fill the gap.
 *
 * Deliberately swallows *every* failure, including a revoked session: an
 * optional check must never turn a readable page into an error.
 */
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    if (header?.startsWith('Bearer ')) {
      const payload = verifyAccessToken(header.slice(7))
      const session = await prisma.userSession.findUnique({ where: { id: payload.sid } })
      if (session && !session.revokedAt && session.expiresAt >= new Date()) {
        req.user = { id: payload.sub, sessionId: payload.sid }
      }
    }
  } catch {
    // Anonymous is a valid state on these routes.
  }
  return next()
}
