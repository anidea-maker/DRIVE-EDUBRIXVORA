import { prisma } from '../../config/prisma.js'

/**
 * API-key request budgets.
 *
 * `memory` is the default for the documented single-service deployment: it is
 * lossy and cheap. `database` uses a unique (key, minute-window) row so every
 * instance in a multi-instance deployment sees the same counter. A DB failure
 * falls back to the in-memory limiter rather than turning a rate-limit check
 * into a hard outage; authentication has already read the DB by this point.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000

export type RateLimitStorage = 'memory' | 'database'

type UpsertArgs = {
  where: { apiKeyId_windowStart: { apiKeyId: string; windowStart: Date } }
  create: { apiKeyId: string; windowStart: Date; count: number }
  update: { count: { increment: number } }
  select: { count: true }
}

export type RateLimitStore = {
  upsert(args: UpsertArgs): Promise<{ count: number }>
}

type MemoryBucket = { count: number; resetAt: number }
const memoryBuckets = new Map<string, MemoryBucket>()

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of memoryBuckets) if (bucket.resetAt <= now) memoryBuckets.delete(key)
}, RATE_LIMIT_WINDOW_MS).unref?.()

export function takeMemoryToken(keyId: string, limit: number, now = Date.now()) {
  const resetAt = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS + RATE_LIMIT_WINDOW_MS
  const bucket = memoryBuckets.get(keyId)
  if (!bucket || bucket.resetAt <= now) {
    memoryBuckets.set(keyId, { count: 1, resetAt })
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt }
  }
  bucket.count += 1
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  }
}

export async function takeApiKeyToken(
  keyId: string,
  limit: number,
  options: { storage?: RateLimitStorage; now?: number; store?: RateLimitStore } = {},
) {
  const { storage = 'memory', now = Date.now(), store } = options
  if (storage !== 'database' || limit <= 0) return takeMemoryToken(keyId, limit, now)
  const windowStart = new Date(Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS)
  const resetAt = windowStart.getTime() + RATE_LIMIT_WINDOW_MS
  try {
    const resolved = store ?? (prisma.apiKeyRateLimitWindow as unknown as RateLimitStore)
    const row = await resolved.upsert({
      where: { apiKeyId_windowStart: { apiKeyId: keyId, windowStart } },
      create: { apiKeyId: keyId, windowStart, count: 1 },
      update: { count: { increment: 1 } },
      select: { count: true },
    })
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      resetAt,
    }
  } catch {
    return takeMemoryToken(keyId, limit, now)
  }
}
