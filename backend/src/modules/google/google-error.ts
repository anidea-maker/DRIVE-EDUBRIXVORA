/**
 * One classification of Google OAuth failures, shared by the sign-in callback
 * (`/auth/google/callback`) and the connect callback
 * (`/connected-accounts/google/callback`).
 *
 * The codes here are contract: `frontend/src/lib/google-connect-errors.ts` turns
 * them into the sentence the user reads. Adding one requires adding it there too.
 */
export type ConnectFailure =
  | 'STATE_EXPIRED'
  | 'DRIVE_API_DISABLED'
  | 'PERMISSION_DENIED'
  | 'INVALID_GRANT'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'QUOTA_SYNC'
  | 'CONFIG_MISSING'
  | 'UNKNOWN'

type GoogleLikeError = {
  code?: number | string
  status?: number
  message?: string
  name?: string
  errors?: Array<{ reason?: string; message?: string }>
  response?: { data?: { error?: { status?: string; message?: string; errors?: Array<{ reason?: string }> } } }
  issues?: Array<{ message?: string; path?: Array<string | number> }>
} | null

/** `code | reasons | message` - the one line worth having in the server log. */
export function describeGoogleError(error: unknown): string {
  const err = error as GoogleLikeError
  const reasons = err?.errors?.map((e) => e.reason).filter(Boolean).join(', ')
  const issues = err?.issues?.map((issue) => issue.message).filter(Boolean).join('; ')
  return [err?.code, reasons || issues, err?.message].filter(Boolean).join(' | ') || String(error)
}

export function classifyGoogleError(error: unknown): ConnectFailure {
  const err = error as GoogleLikeError

  const status = err?.code ?? err?.status ?? err?.response?.data?.error?.status
  const reasons = [
    ...(err?.errors?.map((e) => e.reason) ?? []),
    ...(err?.response?.data?.error?.errors?.map((e) => e.reason) ?? []),
    err?.response?.data?.error?.status,
    err?.response?.data?.error?.message,
    err?.message,
    err?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (/invalid_grant|invalid grant|revoked|expired or revoked|token has been/.test(reasons)) return 'INVALID_GRANT'
  if (/has not been used|is disabled|accessnotconfigured|service_disabled|service disabled|drive api/.test(reasons)) return 'DRIVE_API_DISABLED'
  if (/invalid_client|unauthorized_client|deleted_client|client_secret|client_id/.test(reasons)) return 'CONFIG_MISSING'
  if (/invalid_scope|invalid_request|redirect_uri_mismatch|redirect uri|malformed/.test(reasons)) return 'TOKEN_EXCHANGE_FAILED'
  if (/insufficient|insufficientpermissions|permission|forbidden|insufficient_scope/.test(reasons) || status === 403) return 'PERMISSION_DENIED'
  if (/prisma|p20\d\d|p1\d\d\d|database|econnrefused|etimedout|connect/.test(reasons)) return 'UNKNOWN'
  return 'UNKNOWN'
}
