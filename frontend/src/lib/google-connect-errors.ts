/**
 * Human explanations for the OAuth reason codes the backend sends.
 *
 * Both the connect popup (`/google-connected?reason=…`) and the Google sign-in
 * page (`/google-auth?reason=…`) used to show a single generic sentence, so a
 * disabled Drive API was indistinguishable from a broken deployment. Keeping the
 * mapping here means the two flows cannot drift apart, and it can be unit tested
 * without a browser.
 */
export type ConnectFailureReason =
  | 'DRIVE_API_DISABLED'
  | 'PERMISSION_DENIED'
  | 'INVALID_GRANT'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'STATE_EXPIRED'
  | 'QUOTA_SYNC'
  | 'UNKNOWN'

const CONNECT: Record<ConnectFailureReason, string> = {
  DRIVE_API_DISABLED:
    'Google Drive API is not enabled for your Google Cloud project. Open Google Cloud -> APIs & Services -> Library -> "Google Drive API" -> Enable, wait a minute, then retry.',
  PERMISSION_DENIED:
    'Google refused access to the Drive API. Check that the Drive API is enabled and that the consent screen is published, then retry.',
  INVALID_GRANT:
    'Google did not return a refresh token, so access cannot be kept. Retry and approve every permission - if this repeats, remove 9Drive from your Google account permissions and try again.',
  TOKEN_EXCHANGE_FAILED:
    'Google rejected the code exchange. Usually the redirect URI in Google Cloud does not exactly match this site - check Settings -> Google OAuth Credentials and the Authorized redirect URIs.',
  STATE_EXPIRED: 'This connection attempt expired or was already used. Start it again.',
  QUOTA_SYNC: 'The Drive account was connected, but reading its storage quota failed.',
  UNKNOWN: 'Google returned an unexpected error. The backend log shows the exact reason.',
}

const SIGN_IN: Record<ConnectFailureReason, string> = {
  DRIVE_API_DISABLED: CONNECT.DRIVE_API_DISABLED,
  PERMISSION_DENIED: CONNECT.PERMISSION_DENIED,
  INVALID_GRANT:
    'Google did not grant offline access. Retry and approve every permission. If it repeats, remove 9Drive from your Google account permissions and sign in again.',
  TOKEN_EXCHANGE_FAILED: CONNECT.TOKEN_EXCHANGE_FAILED,
  STATE_EXPIRED: 'That sign-in link expired. Please start again.',
  QUOTA_SYNC: CONNECT.QUOTA_SYNC,
  UNKNOWN: 'Google sign-in failed. Please try again.',
}

function normalize(reason: string | null | undefined): ConnectFailureReason {
  const key = (reason ?? '').trim().toUpperCase() as ConnectFailureReason
  return key in CONNECT ? key : 'UNKNOWN'
}

/** Explanation shown on the connect popup (`/google-connected`). */
export function explainConnectFailure(reason: string | null | undefined): string {
  return CONNECT[normalize(reason)]
}

/** Explanation shown on the sign-in page (`/google-auth`). */
export function explainSignInFailure(reason: string | null | undefined): string {
  return SIGN_IN[normalize(reason)]
}

/**
 * True when the account was connected but its quota could not be read - the
 * screen must say "connected, quota unavailable", not "failed".
 */
export function isQuotaOnlyFailure(status: string | null | undefined, quota: string | null | undefined): boolean {
  return status === 'success' && quota === 'failed'
}
