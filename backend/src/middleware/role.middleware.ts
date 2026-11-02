import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { canManageAdministrators, canManageResources, effectiveRole, isActive, type UserRole } from '../modules/auth/roles.js'

export type RoleRequest = Request & {
  user?: { id: string; sessionId: string }
  /** Filled by this middleware after a database lookup, never by the client. */
  role?: UserRole
}

/**
 * Verifies the caller's role on the server for every protected operation.
 *
 * Designed to run after `requireAuth` (dashboard session) or `requireApiKey`
 * (Edvanta server-to-server key): both set `req.user.id`, but neither trusts a
 * role claim from the request. An API key cannot widen the role of its owner.
 */
export function requireRole(requirement: 'manage_resources' | 'manage_administrators') {
  const allowed = requirement === 'manage_resources' ? canManageResources : canManageAdministrators

  return async (req: RoleRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Sign in or send a valid API key.' })
      }
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, email: true, role: true, status: true },
      })
      if (!user || !isActive(user)) {
        return res.status(403).json({ code: 'ACCOUNT_DISABLED', message: 'This account is not active.' })
      }
      const role = effectiveRole(user)
      if (!allowed(role)) {
        return res.status(403).json({
          code: 'ROLE_FORBIDDEN',
          message: `This operation requires ${requirement === 'manage_resources' ? 'an administrator' : 'a super administrator'}; the authenticated account is ${role}.`,
          requiredPermission: requirement,
        })
      }
      req.role = role
      return next()
    } catch (error) {
      return next(error)
    }
  }
}
