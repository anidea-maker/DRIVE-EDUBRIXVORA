import type { NextFunction, Request, Response } from 'express'
import { BUILD_COMMIT } from '../config/build.js'

/**
 * Last-resort error answer.
 *
 * Always JSON with a message and the path: an HTML or blank 500 in a browser tab
 * says nothing about what broke, and the OAuth callbacks in particular must be
 * diagnosable from the tab that failed.
 */
const OAUTH_PATHS = ['/google/callback', '/google/connect', '/connected-accounts/google/callback']

export function errorMiddleware(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const message = error instanceof Error ? error.message : 'Internal server error'
  const name = error instanceof Error ? error.name : 'Error'
  const isOauth = OAUTH_PATHS.some((path) => req.path.endsWith(path))
  const accepted = req.accepts(['json', 'html'])

  console.error(`[error] ${req.method} ${req.originalUrl} -> ${name}: ${message}`)

  if (res.headersSent) return

  // A browser following an OAuth redirect gets a readable page, not a JSON blob.
  if (isOauth && accepted === 'html') {
    return res
      .status(500)
      .type('html')
      .send(
        [
          '<!doctype html><html><head><meta charset="utf-8"><title>Connection failed</title></head>',
          '<body style="font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;padding:40px">',
          '<h1 style="font-size:1.1rem">The server could not finish this connection</h1>',
          `<p style="color:#475569">${name}: ${message.replace(/[<>&]/g, '')}</p>`,
          `<p style="color:#64748b;font-size:.85rem">Build ${BUILD_COMMIT}. Open <a href="/api/diagnostics">/api/diagnostics</a> for the deployment report.</p>`,
          '</body></html>',
        ].join(''),
      )
  }

  return res.status(500).json({
    code: 'INTERNAL_SERVER_ERROR',
    message,
    name,
    path: req.originalUrl,
    commit: BUILD_COMMIT,
  })
}
