import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { BUILD_COMMIT } from '../config/build.js'
import { safeStorageProblem } from '../modules/public-api/safe-errors.js'

/**
 * Last-resort error answer.
 *
 * Always JSON with a stable code and a safe sentence: an HTML or blank 500 in a
 * browser tab says nothing about what broke, and raw provider errors can leak
 * bucket names, endpoints, account emails or tokens. Only allowlisted codes and
 * operator-safe messages are returned or logged.
 */
const OAUTH_PATHS = ['/google/callback', '/google/connect', '/connected-accounts/google/callback']

/**
 * A request that does not match a route's schema is the client's mistake, so it is
 * a 400 with the offending fields - not the 500 (and a raw JSON dump of the issues)
 * that `next(zodError)` used to produce.
 */
function validationResponse(error: ZodError) {
  const issues = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }))
  return {
    code: 'VALIDATION_FAILED',
    message: `Invalid request: ${issues.map((issue) => `${issue.field} - ${issue.message}`).join('; ')}`,
    issues,
  }
}

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    console.warn(`[error] ${req.method} ${req.originalUrl} -> 400 validation:`, error.issues.map((issue) => issue.path.join('.')).join(', '))
    if (res.headersSent) return
    return res.status(400).json({ ...validationResponse(error), path: req.originalUrl, commit: BUILD_COMMIT })
  }

  const problem = safeStorageProblem(error, 'INTERNAL_SERVER_ERROR')
  const isOauth = OAUTH_PATHS.some((path) => req.path.endsWith(path))
  const accepted = req.accepts(['json', 'html'])

  console.error(`[error] ${req.method} ${req.originalUrl} -> ${problem.code}`)

  if (res.headersSent) return

  // A browser following an OAuth redirect gets a readable page, not a JSON blob.
  if (isOauth && accepted === 'html') {
    return res
      .status(problem.status)
      .type('html')
      .send(
        [
          '<!doctype html><html><head><meta charset="utf-8"><title>Connection failed</title></head>',
          '<body style="font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;padding:40px">',
          '<h1 style="font-size:1.1rem">The server could not finish this connection</h1>',
          `<p style="color:#475569">${problem.message.replace(/[<>&]/g, '')}</p>`,
          `<p style="color:#64748b;font-size:.85rem">Build ${BUILD_COMMIT}. Open <a href="/api/diagnostics">/api/diagnostics</a> for the deployment report.</p>`,
          '</body></html>',
        ].join(''),
      )
  }

  return res.status(problem.status).json({
    code: problem.code,
    message: problem.message,
    path: req.originalUrl,
    commit: BUILD_COMMIT,
  })
}
