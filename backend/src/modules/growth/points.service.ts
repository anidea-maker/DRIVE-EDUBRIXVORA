import { prisma } from '../../config/prisma.js'
import { DEFAULT_POINTS_RULES, HXP_ACTIVITIES, isHxpActivity, type HxpActivity } from './catalog.js'

/**
 * HXP award logic.
 *
 * Three rules shape this file, and each one is a bug avoided rather than a
 * feature added:
 *
 * 1. The ledger is append-only. A balance is `SUM(points)` over the rows, never a
 *    stored counter, so a correction adds a row instead of rewriting history.
 * 2. A rule change must not rewrite the past. Each row snapshots the rule values
 *    it was paid under, which is why `pointsLedgerEntry.rulePoints` exists.
 * 3. A retried submission must not pay twice. The client sends a `reference`; the
 *    unique index on it turns a double-submit into a no-op, not a double payout.
 */

export type AwardInput = {
  userId: string
  activity: string
  /** 0-100 from the client: a test score, a watch percentage, note length. */
  score?: number | null
  fileId?: string | null
  note?: string | null
  reference?: string | null
}

export type AwardResult =
  | {
      ok: true
      awarded: true
      activity: HxpActivity
      points: number
      rulePoints: number
      bonusPoints: number
      balance: number
      todayPoints: number
      cappedBy: 'daily_cap' | null
    }
  | {
      ok: true
      awarded: false
      activity: HxpActivity
      points: 0
      reason: 'already_awarded'
      balance: number
      todayPoints: number
    }
  | { ok: false; code: string; message: string; status: number }

/** Midnight UTC today. The daily cap is per calendar day, not a rolling window. */
export function startOfUtcDay(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Pure points arithmetic, exported so the rule table can be tested without a
 * database. Returns the award, or the capped award when the day's budget is gone.
 */
export function computeAward(input: {
  points: number
  bonusPoints: number
  bonusThreshold: number
  dailyCap: number
  score?: number | null
  alreadyToday: number
}): { points: number; rulePoints: number; bonusPoints: number; cappedBy: 'daily_cap' | null } {
  const base = Math.max(0, Math.trunc(input.points))
  // A bonus only applies when the rule asks for one AND the caller reported a
  // score. A missing score is "unknown", not "zero", so it never subtracts.
  const score = typeof input.score === 'number' && Number.isFinite(input.score) ? Math.trunc(input.score) : null
  const earnedBonus =
    input.bonusPoints > 0 && input.bonusThreshold > 0 && score !== null && score >= input.bonusThreshold
      ? Math.max(0, Math.trunc(input.bonusPoints))
      : 0

  let points = base + earnedBonus
  let cappedBy: 'daily_cap' | null = null
  if (input.dailyCap > 0) {
    const remaining = Math.max(0, input.dailyCap - Math.max(0, input.alreadyToday))
    if (points > remaining) {
      points = remaining
      cappedBy = 'daily_cap'
    }
  }

  return { points, rulePoints: base, bonusPoints: earnedBonus, cappedBy }
}

/** Today's earned total for one activity, ignoring reversals below zero. */
export async function pointsToday(userId: string, activity: HxpActivity, now = new Date()) {
  const rows = await prisma.pointsLedgerEntry.aggregate({
    where: { userId, activity, createdAt: { gte: startOfUtcDay(now) } },
    _sum: { points: true },
  })
  return rows._sum.points ?? 0
}

/** The balance is a sum of the ledger, recomputed rather than cached. */
export async function pointsBalance(userId: string) {
  const rows = await prisma.pointsLedgerEntry.aggregate({ where: { userId }, _sum: { points: true } })
  return rows._sum.points ?? 0
}

/**
 * The rule table, created on first read from the defaults.
 *
 * Lazy rather than seeded at deploy time: a self-hosted instance that has never
 * opened the Coming Soon page should still be able to earn points, and an
 * upgrade should not need a manual step. `createMany` with `skipDuplicates`
 * keeps concurrent first-reads from racing.
 */
export async function ensurePointsRules() {
  const existing = await prisma.pointsRule.findMany()
  if (existing.length >= HXP_ACTIVITIES.length) return existing

  const known = new Set(existing.map((rule) => rule.activity))
  const missing = DEFAULT_POINTS_RULES.filter((rule) => !known.has(rule.activity))
  if (missing.length === 0) return existing

  // `createMany` cannot skip duplicates on SQLite, so create one row at a time and
  // treat a duplicate key as "someone else seeded it first".
  for (const rule of missing) {
    await prisma.pointsRule
      .create({
        data: {
          activity: rule.activity,
          label: rule.label,
          description: rule.description,
          points: rule.points,
          bonusPoints: rule.bonusPoints,
          bonusThreshold: rule.bonusThreshold,
          dailyCap: rule.dailyCap,
          enabled: true,
        },
      })
      .catch((error) => {
        if (String(error?.code) !== 'P2002') throw error
      })
  }
  return prisma.pointsRule.findMany()
}

/** Awards points for one verified activity, honouring the ledger's invariants. */
export async function awardPoints(input: AwardInput): Promise<AwardResult> {
  const activity = String(input.activity ?? '').trim().toLowerCase()
  if (!isHxpActivity(activity)) {
    return {
      ok: false,
      status: 400,
      code: 'HXP_ACTIVITY_UNKNOWN',
      message: `"${input.activity}" is not trackable. Use one of: ${HXP_ACTIVITIES.join(', ')}.`,
    }
  }

  const rules = await ensurePointsRules()
  const rule = rules.find((candidate) => candidate.activity === activity)
  if (!rule) {
    return { ok: false, status: 503, code: 'HXP_RULES_UNAVAILABLE', message: 'The points rules could not be loaded. Try again in a moment.' }
  }
  if (!rule.enabled) {
    return {
      ok: false,
      status: 409,
      code: 'HXP_ACTIVITY_DISABLED',
      message: `${rule.label} does not earn points right now. An administrator turned this activity off.`,
    }
  }

  const reference = input.reference?.trim() || null
  if (reference) {
    const seen = await prisma.pointsLedgerEntry.findUnique({ where: { reference } })
    if (seen) {
      // Same reference, same person: a retry. Answer with the balance rather than
      // an error, so a flaky client can safely repeat the call.
      if (seen.userId !== input.userId) {
        return { ok: false, status: 409, code: 'HXP_REFERENCE_TAKEN', message: 'That reference belongs to another account.' }
      }
      return {
        ok: true,
        awarded: false,
        activity,
        points: 0,
        reason: 'already_awarded',
        balance: await pointsBalance(input.userId),
        todayPoints: await pointsToday(input.userId, activity),
      }
    }
  }

  const alreadyToday = await pointsToday(input.userId, activity)
  const award = computeAward({
    points: rule.points,
    bonusPoints: rule.bonusPoints,
    bonusThreshold: rule.bonusThreshold,
    dailyCap: rule.dailyCap,
    score: input.score ?? null,
    alreadyToday,
  })

  if (award.points <= 0) {
    return {
      ok: false,
      status: 429,
      code: 'HXP_DAILY_CAP_REACHED',
      message: `${rule.label} has paid its daily maximum (${rule.dailyCap} HXP) for today. It resets at 00:00 UTC.`,
    }
  }

  try {
    await prisma.pointsLedgerEntry.create({
      data: {
        userId: input.userId,
        activity,
        points: award.points,
        rulePoints: award.rulePoints,
        bonusPoints: award.bonusPoints,
        fileId: input.fileId?.trim() || null,
        note: input.note?.trim().slice(0, 500) || null,
        reference,
      },
    })
  } catch (error) {
    /**
     * A unique-reference collision that survived the pre-check means two requests
     * raced. One of them won the insert; this one must report "already awarded"
     * rather than a 500, or a retry storm looks like a server fault.
     */
    if (reference && String((error as { code?: string }).code) === 'P2002') {
      return {
        ok: true,
        awarded: false,
        activity,
        points: 0,
        reason: 'already_awarded',
        balance: await pointsBalance(input.userId),
        todayPoints: await pointsToday(input.userId, activity),
      }
    }
    throw error
  }

  return {
    ok: true,
    awarded: true,
    activity,
    points: award.points,
    rulePoints: award.rulePoints,
    bonusPoints: award.bonusPoints,
    balance: await pointsBalance(input.userId),
    todayPoints: alreadyToday + award.points,
    cappedBy: award.cappedBy,
  }
}

/** Per-activity totals for the "where did my HXP come from" breakdown. */
export async function pointsSummary(userId: string) {
  const rules = await ensurePointsRules()
  const [grouped, recent] = await Promise.all([
    prisma.pointsLedgerEntry.groupBy({ by: ['activity'], where: { userId }, _sum: { points: true }, _count: { _all: true } }),
    prisma.pointsLedgerEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  const byActivity = new Map(grouped.map((row) => [row.activity, row]))
  const balance = grouped.reduce((sum, row) => sum + (row._sum.points ?? 0), 0)

  return {
    balance,
    activities: rules
      .slice()
      .sort((a, b) => HXP_ACTIVITIES.indexOf(a.activity as HxpActivity) - HXP_ACTIVITIES.indexOf(b.activity as HxpActivity))
      .map((rule) => {
        const row = byActivity.get(rule.activity)
        return {
          activity: rule.activity,
          label: rule.label,
          enabled: rule.enabled,
          points: rule.points,
          bonusPoints: rule.bonusPoints,
          bonusThreshold: rule.bonusThreshold,
          dailyCap: rule.dailyCap,
          earned: row?._sum.points ?? 0,
          awards: row?._count._all ?? 0,
        }
      }),
    recent: recent.map((entry) => ({
      id: entry.id,
      activity: entry.activity,
      points: entry.points,
      rulePoints: entry.rulePoints,
      bonusPoints: entry.bonusPoints,
      fileId: entry.fileId,
      note: entry.note,
      createdAt: entry.createdAt.toISOString(),
    })),
  }
}
