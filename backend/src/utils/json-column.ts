/**
 * JSON columns on Turso/SQLite.
 *
 * Prisma's SQLite connector has no `Json` scalar type, so the columns that used to
 * be `JSON` in MySQL (`scopes`, `priority_account_ids`, `resource_metadata`,
 * `audit_logs.metadata`) are now `TEXT` holding JSON. These helpers are the only
 * place that converts between the two, so no route has to remember whether it is
 * looking at a parsed value or a string.
 *
 * They are deliberately tolerant on read: a MySQL export, a hand-edited row or a
 * double-encoded value all resolve to a usable array/object instead of throwing in
 * the middle of a request.
 */

/** Parses a TEXT cell into `unknown`, returning `fallback` for NULL or invalid JSON. */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value as T // already parsed by a caller
  const trimmed = value.trim()
  if (!trimmed) return fallback
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return fallback
  }
}

/** Reads a TEXT column that holds a JSON array of strings (scopes, account ids). */
export function jsonStringArray(value: unknown): string[] {
  const parsed = parseJsonColumn<unknown>(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === 'string')
}

/** Serializes an array/object for storage; `undefined` stays `undefined` so Prisma skips the column. */
export function toJsonColumn(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return null as unknown as string
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

/** Serializes a required JSON array, defaulting to `[]`. */
export function toJsonArrayColumn(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(Array.isArray(value) ? value : [])
}
