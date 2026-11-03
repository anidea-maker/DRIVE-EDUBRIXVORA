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

/**
 * The session is gone and could not be refreshed (revoked, expired, or the
 * database was replaced). Clear it and go to the login page once, instead of
 * leaving the app on screen with every request failing.
 */
let redirectingToLogin = false
function endSession() {
  clearAuthSession()
  if (typeof window === 'undefined' || redirectingToLogin) return
  const { pathname } = window.location
  if (pathname === '/login' || pathname === '/register' || pathname === '/google-auth') return
  redirectingToLogin = true
  window.location.replace(`/login?reason=session&next=${encodeURIComponent(pathname + window.location.search)}`)
}

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
    const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 120)
    throw new Error(`"${url}" returned a non-JSON response (status ${response.status})${snippet ? `: ${snippet}` : ' with an empty body'}.`)
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

/**
 * The error a failed request throws.
 *
 * A bare `Request failed (404)` is the one message this file must never produce.
 * It happens when the response is 404/500 **and** its body is not JSON - a static
 * host answering `/api/*` itself, an nginx `try_files` miss, a truncated proxy
 * response - and it reports the symptom while hiding the cause. The caller then
 * sees "Request failed (404)" with no path, no base URL and no next step.
 *
 * So the body is read once and every outcome keeps its detail:
 *   - a JSON error body  -> its `message`, plus `code` (the API's stable contract)
 *   - an HTML page       -> `readJson`'s diagnosis of which URL answered with HTML
 *   - an empty body      -> the method, the full URL and what to check
 *
 * `skipAuth` callers (login, register) rely on the 401 branch above, so the
 * session is ended before this runs, never here.
 */
async function requestFailed(response: Response, url: string, options: ApiOptions): Promise<Error> {
  const status = response.status
  const statusText = response.statusText ? ` ${response.statusText}` : ''
  const method = (options.method ?? 'GET').toUpperCase()
  const isApiBase = /\/api\/?$/.test(url)

  let body: unknown = null
  let bodyProblem: string | null = null
  try {
    body = await readJson(response, url)
  } catch (error) {
    // A non-JSON body is the interesting case: keep the diagnosis, not a status.
    bodyProblem = error instanceof Error ? error.message : String(error)
  }

  const payload = (body ?? {}) as { message?: string; code?: string; hint?: string }
  const detail = typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : null
  const code = typeof payload.code === 'string' ? payload.code : null

  if (status === 404 && isApiBase) {
    // Reaching the API's base with a 404 is a routing problem, not a missing
    // record: say where the request went so the wrong base URL is obvious.
    return new Error(
      `${url} answered 404 - the API base URL is wrong. It must end in /api (so ${method} /files becomes /api/files), and the host must be this deployment's backend, not a static site. ` +
        `Check the base URL shown in Storage API, and API_UPSTREAM if this runs behind a proxy.` +
        (payload.hint ? ` ${payload.hint}` : ''),
    )
  }

  if (status === 404 && !detail && !bodyProblem) {
    // No JSON body and no HTML: something in front of the API answered. The URL
    // is the only clue worth showing, so it is included verbatim.
    return new Error(
      `${method} ${url} returned 404 with an empty response. The request did not reach the API - ` +
        `that host serves static files or a different app. Point the base URL at the backend, then retry.`,
    )
  }

  // Prefer the API's own sentence, then the HTML diagnosis, then a plain status.
  const message =
    detail ??
    bodyProblem ??
    `${method} ${url} failed with ${status}${statusText} and an empty response body. Check that the backend is running and that API_UPSTREAM points at it.`

  const error = new Error(message)
  // `code` is what an integration branches on (API_KEY_SCOPE_MISSING, ...), so it
  // is preserved on the Error object instead of being flattened into the text.
  if (code) (error as Error & { code?: string }).code = code
  return error
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
    // `skipAuth` means the caller was not relying on a session (login, register),
    // so a 401 there is a wrong password, not an expired session.
    if (response.status === 401 && !options.skipAuth) endSession()
    throw await requestFailed(response, url, options)
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
