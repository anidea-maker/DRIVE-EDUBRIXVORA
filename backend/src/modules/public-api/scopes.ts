/**
 * The permission model for the public storage API.
 *
 * Kept in one place because three things must agree: what a key stores, what a
 * route demands, and what the dashboard offers when a key is created. The old
 * API shipped a single scope (`files:upload`) that let an external site write
 * files it could never read back, which is not storage - it is a mailbox. These
 * three scopes cover the whole lifecycle of an object.
 */
export type ApiScope = 'files:read' | 'files:write' | 'files:delete'

export type ApiScopeInfo = {
  id: ApiScope
  label: string
  description: string
  grants: string[]
}

export const API_SCOPES: readonly ApiScopeInfo[] = [
  {
    id: 'files:read',
    label: 'Read',
    description: 'List objects/files, inspect metadata, download bytes.',
    grants: ['GET /v1/files', 'GET /v1/files/:id/content', 'GET /v1/objects', 'GET /v1/objects/:key', 'HEAD /v1/objects/:key'],
  },
  {
    id: 'files:write',
    label: 'Write',
    description: 'Upload/replace objects and files, create folders, mint share/signed links.',
    grants: ['POST /v1/files', 'PUT /v1/objects/:key', 'POST /v1/objects/sign', 'POST /v1/folders', 'POST /v1/files/:id/share'],
  },
  {
    id: 'files:delete',
    label: 'Delete',
    description: 'Delete objects, move files and folders to the trash.',
    grants: ['DELETE /v1/files/:id', 'DELETE /v1/objects/:key'],
  },
]

export const ALL_SCOPES: ApiScope[] = API_SCOPES.map((scope) => scope.id)

/**
 * `files:upload` was the only scope the first version of the API understood.
 * It still has to authorise an upload, or every key handed out before this
 * release stops working the moment it is deployed.
 *
 * It is deliberately *not* widened to read/delete: a key that was given to a
 * third party to push files should not silently gain the ability to list and
 * download them. Those keys get an explicit error naming the fix instead.
 */
const LEGACY_ALIASES: Record<string, ApiScope> = { 'files:upload': 'files:write' }

export function normalizeScopes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function isApiScope(value: string): value is ApiScope {
  return ALL_SCOPES.includes(value as ApiScope)
}

/**
 * Restrict what a caller asked for to scopes that exist, keeping the canonical
 * order. Asking for nothing means "all", which is what the dashboard sends by
 * default; asking for something that does not exist yields an empty list so the
 * route can reject it instead of quietly handing out more access.
 */
export function selectScopes(requested: unknown): ApiScope[] {
  const wanted = normalizeScopes(requested)
  if (wanted.length === 0) return [...ALL_SCOPES]
  return ALL_SCOPES.filter((scope) => wanted.includes(scope))
}

export function grantsScope(stored: unknown, needed: ApiScope): boolean {
  const scopes = normalizeScopes(stored)
  if (scopes.includes(needed)) return true
  // A legacy scope grants whatever it maps *to*, so the lookup runs from the
  // stored scope. Reading it the other way round silently denied every write
  // from a pre-scopes key - caught by the smoke check, not by the type system.
  return scopes.some((scope) => LEGACY_ALIASES[scope] === needed)
}

/** Scopes that are stored but no longer in the catalogue - shown as-is, never trusted. */
export function unknownScopes(stored: unknown): string[] {
  return normalizeScopes(stored).filter((scope) => !isApiScope(scope) && !(scope in LEGACY_ALIASES))
}
