import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'
import { resolveApiBase } from '@/lib/api-base'

const DEV_API_URL = 'http://localhost:4000'

const resolved = resolveApiBase(
  import.meta.env.VITE_API_URL,
  typeof window === 'undefined' ? '' : window.location.host,
)

if (resolved.note) console.warn(`[api] ${resolved.note}`)

/** Same-origin `/api` (proxied by nginx) in production, absolute URL in dev. */
export const API_URL = import.meta.env.PROD ? resolved.base : resolved.base.startsWith('/') ? DEV_API_URL : resolved.base

type ApiOptions = RequestInit & { skipAuth?: boolean; retry?: boolean }

/** Reads a response body as JSON and turns "got HTML instead" into a useful error. */
async function readJson(response: Response, url: string): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null

  try {
    return JSON.parse(text)
  } catch {
    const trimmed = text.trimStart()
    if (trimmed.startsWith('<')) {
      const hint = response.ok
        ? `"${url}" returned HTML instead of JSON. The API base URL is wrong - it is hitting the app itself, not the backend. Check VITE_API_URL (build time) and API_UPSTREAM (runtime proxy) on the frontend service.`
        : `"${url}" returned an HTML error page (status ${response.status}). The request never reached the API - check API_UPSTREAM on the frontend service.`
      throw new Error(hint)
    }
    throw new Error(`"${url}" returned a non-JSON response (status ${response.status}).`)
  }
}

/**
 * Parses a Response as JSON, with the same HTML-body diagnosis as `readJson`.
 * Exported for the few call sites that need the raw Response (uploads, backups).
 */
export async function safeJson(response: Response): Promise<unknown> {
  return readJson(response, response.url || '(response)')
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  const url = `${API_URL}/auth/refresh`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) return false
  const data = (await readJson(response, url)) as { accessToken?: string } | null
  if (!data?.accessToken) return false
  setAccessToken(data.accessToken)
  return true
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  const token = getAccessToken()
  if (!options.skipAuth && token) headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  const url = `${API_URL}${path}`
  const response = await fetch(url, { ...options, headers })
  if (response.status === 401 && options.retry !== false && !options.skipAuth && await refreshAccessToken()) {
    return apiFetch<T>(path, { ...options, retry: false })
  }

  if (!response.ok) {
    const error = (await readJson(response, url).catch(() => null)) as { message?: string; code?: string } | null
    if (response.status === 401) clearAuthSession()
    throw new Error(error?.message ?? `Request failed (${response.status})`)
  }

  return (await readJson(response, url)) as T
}

export function formatBytes(input: string | number | bigint | null | undefined) {
  if (input === null || input === undefined) return '--'
  const bytes = Number(input)
  if (!Number.isFinite(bytes)) return '--'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
