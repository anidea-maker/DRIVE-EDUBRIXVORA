import { apiFetch } from '@/lib/api'

export interface GoogleAuthStatus {
  configured: boolean
  redirectUri: string | null
  expectedRedirectUri: string | null
  redirectUriMatchesOrigin: boolean
  hint: string | null
}

/**
 * Starts the Google OAuth flow.
 *
 * Every failure mode gets a sentence the user can act on - a stale build pointing
 * at the SPA, a missing OAuth client in the database, or an unreachable API -
 * instead of the raw `Unexpected token '<'` that a JSON parse of an HTML page
 * produces.
 */
export async function startGoogleAuth(): Promise<void> {
  let status: GoogleAuthStatus
  try {
    status = await apiFetch<GoogleAuthStatus>('/auth/google/status', { skipAuth: true })
  } catch (error) {
    throw new Error(explain(error, 'Could not check whether Google sign-in is available.'))
  }

  if (!status.configured) {
    throw new Error(
      status.hint ??
        'Google sign-in is not set up yet. Add your Google OAuth client ID and secret in Settings -> Google Credentials.',
    )
  }

  // The stored redirect URI is handed to Google verbatim. A localhost value
  // saved during a local run can never complete on a deployed site, so stop with
  // instructions instead of sending the user to a dead callback. Any other
  // mismatch is only a warning: Google may legitimately have it registered.
  const localHostPattern = /^(localhost|127\.0\.0\.1)(:\d+)?$/i
  const storedHost = parseHost(status.redirectUri)
  const originIsLocal = localHostPattern.test(window.location.host)
  if (storedHost && localHostPattern.test(storedHost) && !originIsLocal) {
    throw new Error(
      `Google sign-in is configured for ${status.redirectUri}, which only works on your machine. ` +
        `Open Settings -> Google OAuth Credentials, clear the Redirect URI field and save again to use this site's URL.`,
    )
  }

  let url: string
  try {
    const data = await apiFetch<{ url: string }>('/auth/google/url', { skipAuth: true })
    url = data.url
  } catch (error) {
    throw new Error(explain(error, 'Google sign-in could not be started.'))
  }

  window.location.href = url
}

function parseHost(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function explain(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (!message) return fallback
  if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
    return `${fallback} The API could not be reached - check that this deployment is online.`
  }
  return message
}
