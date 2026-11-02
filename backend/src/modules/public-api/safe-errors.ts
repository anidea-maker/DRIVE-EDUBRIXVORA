/**
 * One place that turns provider/auth/storage failures into safe API answers.
 *
 * Provider SDK messages can contain bucket names, endpoints, account emails,
 * tokens and internal paths. None of that is useful to the external website, so
 * only stable codes and operator-safe sentences leave the process. Logs keep
 * the code, never the raw provider text.
 */
export type SafeProblem = {
  code: string
  message: string
  status: number
}

type KnownProblem = Omit<SafeProblem, 'code'>

const RECONNECT = 'Reconnect or update that account in 9Drive Settings, then retry.'

const KNOWN: Record<string, KnownProblem> = {
  NO_ACCOUNT_WITH_ENOUGH_SPACE: {
    message: 'No connected storage account has room for this object. Connect another account or free up space.',
    status: 507,
  },
  STORAGE_ACCOUNT_UNAVAILABLE: {
    message: `The connected account that stores this object is unavailable or full. ${RECONNECT}`,
    status: 409,
  },
  OBJECT_PROVIDER_MIGRATION_UNSUPPORTED: {
    message: 'Overwriting an object on a different connected provider is not supported. Use a new object key.',
    status: 409,
  },
  UPLOAD_TOO_LARGE: {
    message: 'The upload exceeds this deployment’s configured size limit.',
    status: 413,
  },
  OBJECT_TOO_LARGE: {
    message: 'The upload exceeds this deployment’s configured size limit.',
    status: 413,
  },
  UPLOAD_SIZE_MISMATCH: {
    message: 'The received bytes did not match the declared Content-Length. Retry the upload.',
    status: 400,
  },
  UPLOAD_VERIFICATION_FAILED: {
    message: 'The connected storage provider did not confirm the uploaded object. Retry the upload.',
    status: 502,
  },
  UPLOAD_TRUNCATED: {
    message: 'The upload was interrupted before all declared bytes arrived. Retry the upload.',
    status: 502,
  },
  S3_AUTH_FAILED: {
    message: `The connected storage account credentials were rejected. ${RECONNECT}`,
    status: 502,
  },
  S3_ACCESS_DENIED: {
    message: `The connected storage account is not allowed to perform this operation. ${RECONNECT}`,
    status: 502,
  },
  S3_BUCKET_NOT_FOUND: {
    message: `The connected storage account’s bucket is no longer available. ${RECONNECT}`,
    status: 502,
  },
  S3_WRONG_REGION: {
    message: `The connected storage account’s region is incorrect. ${RECONNECT}`,
    status: 502,
  },
  S3_ENDPOINT_UNREACHABLE: {
    message: 'The connected storage provider could not be reached. Try again later or reconnect the account.',
    status: 502,
  },
  S3_ENDPOINT_NOT_S3: {
    message: `The connected storage account is using a dashboard/API URL instead of its S3 endpoint. ${RECONNECT}`,
    status: 502,
  },
  S3_CONNECTION_FAILED: {
    message: `The connected storage provider rejected the request. ${RECONNECT}`,
    status: 502,
  },
  GOOGLE_DRIVE_OPERATION_FAILED: {
    message: `The connected Google Drive account could not complete the request. ${RECONNECT}`,
    status: 502,
  },
  PROVIDER_FILE_ID_MISSING: {
    message: 'The stored object has no provider reference. Reconcile or re-upload it.',
    status: 502,
  },
  UNKNOWN_PROVIDER: {
    message: `The stored object references an unknown provider. ${RECONNECT}`,
    status: 502,
  },
  DELETE_FAILED: {
    message: 'The connected storage provider refused the delete. Retry later or reconnect the account.',
    status: 502,
  },
  UPLOAD_FAILED: {
    message: 'The connected storage provider could not complete the upload. Retry later or reconnect the account.',
    status: 502,
  },
  INTERNAL_SERVER_ERROR: {
    message: 'The request could not be completed. Check /api/diagnostics for deployment status and retry.',
    status: 500,
  },
}

/** Extracts only a known, allowlisted code; raw error text is never returned. */
export function safeStorageProblem(error: unknown, fallbackCode = 'STORAGE_REQUEST_FAILED'): SafeProblem {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === 'string' ? candidate.code : ''
  const known = KNOWN[code]
  if (known) return { code, ...known }

  // Our own thrown errors sometimes encode the code in the message rather than
  // on `error.code`. Only the prefix is read; the rest may be provider detail.
  const prefix = typeof candidate?.message === 'string' ? candidate.message.split(':')[0]!.trim() : ''
  const prefixed = KNOWN[prefix]
  if (prefixed) return { code: prefix, ...prefixed }

  const fallback = KNOWN[fallbackCode]
  return {
    code: fallbackCode,
    message: fallback?.message ?? 'The storage request could not be completed. Try again later, or check /api/diagnostics after reconnecting the account.',
    status: fallback?.status ?? 502,
  }
}
