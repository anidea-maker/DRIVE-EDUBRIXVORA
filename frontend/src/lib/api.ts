import { clearAuthSession, getAccessToken, getRefreshToken, setAccessToken } from '@/lib/auth'
import { resolveApiBase } from '@/lib/api-base'
import { fetchWithRetry } from '@/lib/fetch-retry'

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

/** First try plus two retries: enough to survive a restart without feeling stuck. */
const ATTEMPTS = 3

/** True when the app is being served from this machine, where the dev hints apply. */
function isLocalOrigin(): boolean {
  if (typeof window === 'undefined') return false
  return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(window.location.hostname)
}

/**
 * Turns a rejected `fetch` (no response at all) into something actionable, with
 * advice that matches where the app is actually running - telling someone on a
 * deployed site to run `npm run dev` is worse than saying nothing.
 */
export function networkError(url: string, error: unknown, attempts = 1): Error {
  const name = (error as { name?: string } | null)?.name
  if (name === 'AbortError') return error instanceof Error ? error : new Error('Request aborted.')

  const reason = error instanceof Error && error.message ? error.message : 'connection failed'
  const tried = attempts > 1 ? ` after ${attempts} attempts` : ''

  if (isLocalOrigin()) {
    return new Error(
      `Could not reach the API at ${url}${tried} (${reason}). ` +
        `Start the backend with "npm run dev" in backend/ (port 4000), or set API_PROXY_TARGET in frontend/.env ` +
        `to the port it actually uses, then retry.`,
    )
  }

  return new Error(
    `Could not reach the API at ${url}${tried} (${reason}). ` +
      `The server may be restarting or waking from sleep - wait a few seconds and try again. ` +
      `If it keeps failing, open ${typeof window === 'undefined' ? '/health' : `${window.location.origin}/health`} - ` +
      `it must return JSON with a "commit" field.`,
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
    response = await fetchWithRetry(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) },
      { attempts: 2, delays: [600] },
    )
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
  const attempts = ATTEMPTS
  let tries = 0
  let response: Response
  try {
    response = await fetchWithRetry(
      url,
      { ...options, headers },
      {
        attempts,
        onRetry: ({ attempt }) => {
          tries = attempt
          console.warn(`[api] ${url} did not answer (attempt ${attempt}/${attempts}); retrying`)
        },
      },
    )
  } catch (error) {
    throw networkError(url, error, Math.max(tries + 1, 1))
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
