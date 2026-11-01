import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'
import { resolveApiBase } from '@/lib/api-base'

const resolved = resolveApiBase(
  import.meta.env.VITE_API_URL,
  typeof window === 'undefined' ? '' : window.location.host,
)

if (resolved.note) console.warn(`[api] ${resolved.note}`)

/**
 * Same-origin `/api` everywhere: nginx proxies it in the Docker image and the Vite
 * dev/preview server proxies it to the backend (see vite.config.ts). A build-time
 * `VITE_API_URL` that names a real API origin is still honoured.
 */
export const API_URL = resolved.base

/** Turns a rejected `fetch` (no response at all) into something actionable. */
export function networkError(url: string, error: unknown): Error {
  const name = (error as { name?: string } | null)?.name
  if (name === 'AbortError') return error instanceof Error ? error : new Error('Request aborted.')
  const detail = error instanceof Error && error.message ? ` (${error.message})` : ''
  return new Error(
    `Could not reach the API at ${url}${detail}. The request never got a response: ` +
      `start the backend ("npm run dev" in backend/, port 4000) or point API_PROXY_TARGET at it, ` +
      `then reload.`,
  )
}

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
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
  } catch {
    return false
  }
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
  let response: Response
  try {
    response = await fetch(url, { ...options, headers })
  } catch (error) {
    throw networkError(url, error)
  }
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
