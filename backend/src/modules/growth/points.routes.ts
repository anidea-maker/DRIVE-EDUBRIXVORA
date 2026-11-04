import { Router } from 'express'
import { z } from 'zod'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireRole } from '../../middleware/role.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { prisma } from '../../config/prisma.js'
import { HXP_ACTIVITIES, isHxpActivity } from './catalog.js'
import { awardPoints, ensurePointsRules, pointsBalance, pointsSummary, pointsToday } from './points.service.js'

/**
 * HXP points.
 *
 * Awarding is separated from setting the price on purpose. A learner's own
 * actions produce ledger rows through `/award`; what those rows are worth is a
 * policy an administrator owns, and it lives behind a different guard.
 */
export const pointsRouter = Router()
pointsRouter.use(requireAuth)

const awardSchema = z.object({
  activity: z.string().trim().min(1).max(32),
  /** Test score or completion percentage, 0-100. */
  score: z.number().int().min(0).max(100).nullish(),
  /**
   * The obvious name for a video's completion, accepted as an alias for `score`.
   *
   * Zod drops unknown keys rather than rejecting them, so a caller that sent
   * `watchPercent` used to get a quiet, bonus-less award - the worst outcome,
   * because the response looked like a success. Both names now mean the same
   * thing and neither can silently vanish.
   */
  watchPercent: z.number().int().min(0).max(100).nullish(),
  fileId: z.string().trim().max(64).nullish(),
  note: z.string().trim().max(500).nullish(),
  /**
   * Client-supplied idempotency key, e.g. `test:42:attempt-1`. Required for
   * `test` because a test is a discrete event that a flaky network can replay,
   * optional elsewhere where a repeat is a genuinely new activity.
   */
  reference: z.string().trim().min(1).max(120).nullish(),
})

/**
 * My balance, my per-activity breakdown, my last twenty awards.
 *
 * One call rather than three, because a dashboard that shows a number always
 * wants the explanation next to it.
 */
pointsRouter.get('/me', async (req: AuthRequest, res, next) => {
  try {
    const summary = await pointsSummary(req.user!.id)
    return res.json({
      ...summary,
      /** The rules in force, so the UI can show "reading is worth 10" without hard-coding it. */
      currency: 'HXP',
      timezone: 'UTC',
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Records a finished activity and pays for it.
 *
 * The caller states what it did; the server decides what that is worth and caps
 * it. Nothing in the request names a point value - if it did, the client would be
 * writing its own grade.
 */
pointsRouter.post('/award', async (req: AuthRequest, res, next) => {
  try {
    const body = awardSchema.parse(req.body ?? {})
    if (!isHxpActivity(body.activity.toLowerCase())) {
      return res.status(400).json({
        code: 'HXP_ACTIVITY_UNKNOWN',
        message: `"${body.activity}" is not trackable. Use one of: ${HXP_ACTIVITIES.join(', ')}.`,
      })
    }
    if (body.activity.toLowerCase() === 'test' && !body.reference) {
      return res.status(400).json({
        code: 'HXP_REFERENCE_REQUIRED',
        message: 'Awarding a test needs a `reference` (for example `test:<id>:attempt:<n>`) so a retried submission cannot pay twice.',
      })
    }
    if (body.fileId) {
      // A fileId that is not this user's would leak the existence of someone
      // else's file through the ledger and the UI that renders it.
      const owned = await prisma.file.findFirst({ where: { id: body.fileId, userId: req.user!.id }, select: { id: true } })
      if (!owned) {
        return res.status(404).json({ code: 'FILE_NOT_FOUND', message: 'That file is not in your library.' })
      }
    }

    const result = await awardPoints({
      userId: req.user!.id,
      activity: body.activity,
      score: (body.score ?? body.watchPercent) ?? null,
      fileId: body.fileId ?? null,
      note: body.note ?? null,
      reference: body.reference ?? null,
    })

    if (!result.ok) {
      return res.status(result.status).json({ code: result.code, message: result.message })
    }
    return res.status(result.awarded ? 201 : 200).json(result)
  } catch (error) {
    return next(error)
  }
})

/** Today's totals, for a widget that polls this rather than the whole summary. */
pointsRouter.get('/today', async (req: AuthRequest, res, next) => {
  try {
    await ensurePointsRules()
    const activities = await Promise.all(
      HXP_ACTIVITIES.map(async (activity) => ({ activity, points: await pointsToday(req.user!.id, activity) })),
    )
    return res.json({ date: new Date().toISOString().slice(0, 10), activities, balance: await pointsBalance(req.user!.id) })
  } catch (error) {
    return next(error)
  }
})

/* -------------------------------------------------------------------------- */
/*  Administration: what each activity is worth                               */
/* -------------------------------------------------------------------------- */

/**
 * The rule editor is restricted to `manage_administrators` (super admins).
 *
 * Points are a currency across every account on the deployment, so one course
 * admin quietly setting "test: 10000" would distort every leaderboard. Super
 * admins set policy; admins can manage the catalogue below.
 */
export const pointsAdminRouter = Router()
pointsAdminRouter.use(requireAuth)
pointsAdminRouter.use(requireRole('manage_administrators'))

const ruleWrite = z.object({
  points: z.number().int().min(0).max(10_000).optional(),
  bonusPoints: z.number().int().min(0).max(10_000).optional(),
  bonusThreshold: z.number().int().min(0).max(100).optional(),
  dailyCap: z.number().int().min(0).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).nullish(),
})

function serializeRule(rule: {
  id: string
  activity: string
  label: string
  description: string | null
  points: number
  bonusPoints: number
  bonusThreshold: number
  dailyCap: number
  enabled: boolean
  updatedById: string | null
  updatedAt: Date
}) {
  return {
    id: rule.id,
    activity: rule.activity,
    label: rule.label,
    description: rule.description,
    points: rule.points,
    bonusPoints: rule.bonusPoints,
    bonusThreshold: rule.bonusThreshold,
    dailyCap: rule.dailyCap,
    enabled: rule.enabled,
    /** The most a learner can earn from this activity in one UTC day. */
    maxDailyPoints: rule.dailyCap > 0 ? rule.dailyCap : null,
    updatedById: rule.updatedById,
    updatedAt: rule.updatedAt.toISOString(),
  }
}

pointsAdminRouter.get('/rules', async (_req, res, next) => {
  try {
    const rules = await ensurePointsRules()
    return res.json({
      rules: rules
        .slice()
        .sort((a, b) => HXP_ACTIVITIES.indexOf(a.activity as never) - HXP_ACTIVITIES.indexOf(b.activity as never))
        .map(serializeRule),
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Changes one activity's value.
 *
 * Existing ledger rows are untouched: they carry the values they were paid under.
 * That is deliberate - a term's points must not shrink because a rule changed
 * afterwards - so the response says how many past awards this affects.
 */
pointsAdminRouter.patch('/rules/:activity', async (req: AuthRequest, res, next) => {
  try {
    const activity = String(req.params.activity).toLowerCase()
    if (!isHxpActivity(activity)) {
      return res.status(400).json({
        code: 'HXP_ACTIVITY_UNKNOWN',
        message: `"${activity}" is not trackable. Use one of: ${HXP_ACTIVITIES.join(', ')}.`,
      })
    }
    const body = ruleWrite.parse(req.body ?? {})
    await ensurePointsRules()

    const before = await prisma.pointsRule.findUnique({ where: { activity } })
    if (!before) return res.status(404).json({ code: 'HXP_RULE_NOT_FOUND', message: 'That rule does not exist.' })

    /*
     * A bonus with a threshold of 0 can never pay, which from the learner's side
     * is indistinguishable from a bug: the rule advertises "+15" and no award
     * ever includes it. Both directions are refused - turning a bonus on without
     * a threshold, and turning a live threshold down to 0 while a bonus stands.
     */
    const nextBonus = body.bonusPoints ?? before.bonusPoints
    const nextThreshold = body.bonusThreshold ?? before.bonusThreshold
    if (nextBonus > 0 && nextThreshold === 0) {
      return res.status(400).json({
        code: 'HXP_BONUS_NEEDS_THRESHOLD',
        message: 'A bonus needs a `bonusThreshold` (1-100) - the score at which it is paid.',
      })
    }

    const rule = await prisma.pointsRule.update({
      where: { activity },
      data: {
        ...(body.points === undefined ? {} : { points: body.points }),
        ...(body.bonusPoints === undefined ? {} : { bonusPoints: body.bonusPoints }),
        ...(body.bonusThreshold === undefined ? {} : { bonusThreshold: body.bonusThreshold }),
        ...(body.dailyCap === undefined ? {} : { dailyCap: body.dailyCap }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.description === undefined ? {} : { description: body.description }),
        updatedById: req.user!.id,
      },
    })

    await createAuditLog(req.user!.id, 'UPDATE_POINTS_RULE', 'points_rule', rule.id, {
      activity,
      before: { points: before.points, bonusPoints: before.bonusPoints, bonusThreshold: before.bonusThreshold, dailyCap: before.dailyCap, enabled: before.enabled },
      after: { points: rule.points, bonusPoints: rule.bonusPoints, bonusThreshold: rule.bonusThreshold, dailyCap: rule.dailyCap, enabled: rule.enabled },
    })

    const pastAwards = await prisma.pointsLedgerEntry.count({ where: { activity } })
    return res.json({
      rule: serializeRule(rule),
      pastAwardsUnaffected: pastAwards,
      note: 'Past awards keep the points they were given. Only new activity uses these values.',
    })
  } catch (error) {
    return next(error)
  }
})

/**
 * Live ledger for one account, so a super admin can answer "why is this student
 * on 340?" without opening a database shell.
 */
pointsAdminRouter.get('/users/:id/ledger', async (req, res, next) => {
  try {
    const userId = String(req.params.id)
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } })
    if (!user) return res.status(404).json({ code: 'USER_NOT_FOUND', message: 'That account does not exist.' })

    const [entries, balance] = await Promise.all([
      prisma.pointsLedgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 }),
      pointsBalance(userId),
    ])
    return res.json({
      user,
      balance,
      entries: entries.map((entry) => ({
        id: entry.id,
        activity: entry.activity,
        points: entry.points,
        rulePoints: entry.rulePoints,
        bonusPoints: entry.bonusPoints,
        fileId: entry.fileId,
        note: entry.note,
        reference: entry.reference,
        createdAt: entry.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    return next(error)
  }
})
