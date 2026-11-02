import type { Response } from 'express'
import { env } from '../config/env.js'
import { spaEnabled } from '../config/spa.js'

/**
 * Redirecting the browser back into the SPA.
 *
 * Two rules, both learned from a deployment where every OAuth callback answered
 * HTTP 500 and the browser showed a blank page:
 *
 *  1. When this process also serves the SPA (single-service Docker), redirect to a
 *     *relative* path. The browser resolves it against the host it is already on,
 *     so a stale or mistyped `FRONTEND_URL` cannot send the user to a dead host.
 *  2. Never let the redirect itself throw. `res.redirect()` validates the
 *     `Location` header and throws `ERR_INVALID_CHAR` on a control character, and
 *     a throw inside a `catch` block turns a useful error screen into a 500.
 */

export type RedirectParams = Record<string, string | number | boolean | null | undefined>

function buildQuery(params?: RedirectParams | URLSearchParams): string {
  const search = new URLSearchParams()
  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => search.set(key, value))
  } else {
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === null || value === undefined || value === '') continue
      search.set(key, String(value))
    }
  }
  return search.toString()
}

/** Characters that make a `Location` header invalid (or split it). */
const INVALID_HEADER_CHARS = /[\u0000-\u001f\u007f]/

/**
 * Same-origin path (`/google-connected?status=error`). Safe for a redirect when
 * this process serves the SPA.
 */
export function frontendPath(pathname: string, params?: RedirectParams | URLSearchParams): string {
  const query = buildQuery(params)
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`
  return query ? `${path}?${query}` : path
}

/**
 * Absolute URL of an SPA page, for the two-service setup where the callback runs
 * on the API host. Falls back to the relative path (or to a bare path) if
 * `FRONTEND_URL` is unusable, instead of throwing.
 */
export function frontendUrl(
  pathname: string,
  params?: RedirectParams | URLSearchParams,
  /** Origin the request arrived on, used when FRONTEND_URL is unusable. */
  requestOrigin?: string | null,
): string {
  const relative = frontendPath(pathname, params)
  // The SPA is served by this process: the browser resolves the path against the
  // host it is already on, so FRONTEND_URL is not involved at all.
  if (spaEnabled) return relative

  // A production deployment with FRONTEND_URL=http://localhost:5173 would send the
  // browser to a host it cannot reach. Stay on the origin that served the request.
  if (!env.FRONTEND_URL_USABLE && requestOrigin && !INVALID_HEADER_CHARS.test(requestOrigin)) {
    try {
      return new URL(relative, requestOrigin).toString()
    } catch {
      return relative
    }
  }

  try {
    const absolute = new URL(relative, env.FRONTEND_URL).toString()
    if (INVALID_HEADER_CHARS.test(absolute)) {
      console.error('[redirect] FRONTEND_URL contains control characters - using a relative redirect. Fix the FRONTEND_URL environment variable.')
      return relative
    }
    return absolute
  } catch (error) {
    console.error(
      `[redirect] FRONTEND_URL (${JSON.stringify(env.FRONTEND_URL)}) is not a usable origin - using a relative redirect:`,
      error instanceof Error ? error.message : error,
    )
    return relative
  }
}

/**
 * Pages that are handed back to the browser after OAuth. Rendered as a static
 * fallback only when a redirect is impossible, so the user always sees the reason
 * instead of a blank 500.
 */
function fallbackPage(title: string, detail: string, link: string): string {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escape(title)}</title>`,
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;',
    'display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}',
    'main{max-width:26rem;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;',
    'box-shadow:0 1px 2px rgba(15,23,42,.06)}h1{font-size:1.05rem;margin:0 0 .5rem}',
    'p{margin:.25rem 0 0;font-size:.9rem;line-height:1.5;color:#475569}',
    'a{display:inline-block;margin-top:1rem;background:#2563eb;color:#fff;text-decoration:none;',
    'padding:.55rem 1rem;border-radius:10px;font-size:.875rem;font-weight:600}</style></head><body><main>',
    `<h1>${escape(title)}</h1><p>${escape(detail)}</p><a href="${escape(link)}">Continue</a>`,
    '</main></body></html>',
  ].join('')
}

/**
 * Redirect, and if that is not possible, explain what happened in the browser.
 * `title`/`detail` are shown only in the fallback, so they should read like UI.
 */
export function redirectToFrontend(
  res: Response,
  pathname: string,
  params?: RedirectParams | URLSearchParams,
  fallback?: { title: string; detail: string },
  requestOrigin?: string | null,
): void {
  const target = frontendUrl(pathname, params, requestOrigin)

  if (res.headersSent) return

  try {
    res.redirect(target)
    return
  } catch (error) {
    console.error('[redirect] could not redirect the browser:', {
      target,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  if (res.headersSent) return

  const path = frontendPath(pathname, params)
  res
    .status(200)
    .type('html')
    .send(
      fallbackPage(
        fallback?.title ?? 'Almost done',
        fallback?.detail ?? 'The server could not redirect this page automatically. Open the link below to see the result.',
        path,
      ),
    )
}
