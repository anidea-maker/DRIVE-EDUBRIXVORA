/**
 * Resolves the API base URL used by the SPA.
 *
 * `VITE_API_URL` is baked in at build time and is easy to get wrong: pointing it
 * at the frontend's own origin sends every call to the SPA, which answers with
 * `index.html` and surfaces as `Unexpected token '<', "<!doctype "...`.
 *
 * Rules (first match wins):
 *   1. unset / empty / the dev default      -> same-origin `/api` (proxied by nginx)
 *   2. a relative base such as `/api`       -> used as-is
 *   3. a URL on the current host            -> its path, or `/api` when it has none
 *   4. anything else                        -> used verbatim (a real API origin)
 *
 * `currentHost` is injected so this stays testable outside a browser.
 */
export interface ApiBaseResolution {
  base: string
  /** Set when the configured value had to be reinterpreted. */
  note?: string
}

const DEV_API_URL = 'http://localhost:4000'
const DEFAULT_PROD_BASE = '/api'

export function resolveApiBase(raw: string | undefined, currentHost = ''): ApiBaseResolution {
  const value = raw?.trim()

  if (!value || value === DEV_API_URL) return { base: DEFAULT_PROD_BASE }

  if (value.startsWith('/')) {
    return { base: value.replace(/\/+$/, '') || DEFAULT_PROD_BASE }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Not a URL and not relative: assume it is a host or path fragment.
    return { base: value.replace(/\/+$/, '') }
  }

  if (currentHost && url.host === currentHost) {
    const path = url.pathname.replace(/\/+$/, '')
    const base = path === '' || path === '/' ? DEFAULT_PROD_BASE : path
    return {
      base,
      note: `VITE_API_URL (${value}) points at this app itself; using "${base}" on the same origin instead.`,
    }
  }

  return { base: url.toString().replace(/\/+$/, '') }
}
