import { apiFetch } from '@/lib/api'

export interface GoogleAuthStatus {
  configured: boolean
  redirectUri: string | null
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

  let url: string
  try {
    const data = await apiFetch<{ url: string }>('/auth/google/url', { skipAuth: true })
    url = data.url
  } catch (error) {
    throw new Error(explain(error, 'Google sign-in could not be started.'))
  }

  window.location.href = url
}

function explain(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  if (!message) return fallback
  if (/Failed to fetch|NetworkError|load failed/i.test(message)) {
    return `${fallback} The API could not be reached - check that this deployment is online.`
  }
  return message
}
