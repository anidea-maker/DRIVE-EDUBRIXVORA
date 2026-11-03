import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireRole } from '../../middleware/role.middleware.js'
import { parseJsonColumn } from '../../utils/json-column.js'

export const auditLogRouter = Router()
auditLogRouter.use(requireAuth)
auditLogRouter.use(requireRole('manage_resources'))

auditLogRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 100
    })
    return res.json({ logs: logs.map((log) => ({ ...log, metadata: parseJsonColumn(log.metadata, null) })) })
  } catch (error) {
    return next(error)
  }
})
