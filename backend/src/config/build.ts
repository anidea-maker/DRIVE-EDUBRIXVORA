/**
 * Which build is actually running, and what it can do.
 *
 * `commit` comes from whatever the platform injects at build/run time. It can lie
 * in one specific case: an old image with a fresh platform env var. `features` is
 * compiled into the JavaScript, so it cannot - if a feature listed here is missing
 * from the behaviour, the running code is older than the env says.
 */

export const BUILD_COMMIT =
  process.env.RENDER_GIT_COMMIT?.slice(0, 7) ||
  process.env.GIT_COMMIT?.slice(0, 7) ||
  process.env.SOURCE_VERSION?.slice(0, 7) ||
  process.env.COMMIT_SHA?.slice(0, 7) ||
  'unknown'

export const BUILD_ENVIRONMENT = process.env.NODE_ENV ?? 'development'

/** Behaviours added after the first deployment - a live build marker. */
export const FEATURES = [
  'health-commit',
  'oauth-reason-codes',
  'oauth-safe-redirect',
  'diagnostics',
] as const

export type Feature = (typeof FEATURES)[number]
