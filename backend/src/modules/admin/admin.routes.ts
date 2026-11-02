import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireRole, type RoleRequest } from '../../middleware/role.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { env } from '../../config/env.js'
import { effectiveRole, USER_ROLES, type UserRole } from '../auth/roles.js'

/**
 * Administrator account management. Every route here needs a live dashboard
 * session AND a server-verified super-admin role. The role is never read from
 * the request body for the *caller*; the body only names the *target*.
 */
export const adminRouter = Router()

adminRouter.use(requireAuth)
adminRouter.use(requireRole('manage_administrators'))

const roleSchema = z.object({ role: z.enum(USER_ROLES) })

function publicUser(user: { id: string; name: string; email: string; role: string; status: string; createdAt: Date }) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    storedRole: user.role,
    effectiveRole: effectiveRole(user),
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  }
}

adminRouter.get('/users', async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
      take: 500,
    })
    return res.json({ users: users.map(publicUser), bootstrapSuperAdmins: env.SUPER_ADMIN_EMAILS.length })
  } catch (error) {
    return next(error)
  }
})

adminRouter.patch('/users/:id/role', async (req: AuthRequest & RoleRequest, res, next) => {
  try {
    const { role } = roleSchema.parse(req.body ?? {})
    const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } })
    if (!target) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'That account does not exist.' })

    if (role !== 'super_admin' && effectiveRole(target) === 'super_admin') {
      const otherSuperAdmins = await prisma.user.count({
        where: { role: 'super_admin', id: { not: target.id }, status: 'active' },
      })
      const bootstrapHasSomeoneElse = env.SUPER_ADMIN_EMAILS.some((email) => email !== target.email.toLowerCase())
      if (otherSuperAdmins === 0 && !bootstrapHasSomeoneElse) {
        return res.status(409).json({
          code: 'LAST_SUPER_ADMIN',
          message: 'Promote another super administrator before demoting the last one, or add another address to SUPER_ADMIN_EMAILS.',
        })
      }
      // A bootstrap super admin keeps the role even when the stored role changes.
      if (env.SUPER_ADMIN_EMAILS.includes(target.email.toLowerCase())) {
        return res.status(409).json({
          code: 'BOOTSTRAP_SUPER_ADMIN',
          message: 'This account is a super administrator through SUPER_ADMIN_EMAILS. Remove it from that setting before changing its stored role.',
        })
      }
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { role: role as UserRole },
      select: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    })
    await createAuditLog(req.user!.id, 'CHANGE_USER_ROLE', 'user', target.id, { role, previousRole: target.role })
    return res.json({ user: publicUser(updated) })
  } catch (error) {
    return next(error)
  }
})
