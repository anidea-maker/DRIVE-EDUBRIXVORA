import fs from 'node:fs'
import path from 'node:path'

/**
 * Is this process also the web server for the SPA?
 *
 * Set `SERVE_FRONTEND` to the directory containing `index.html` (the root
 * Dockerfile uses /app/public). Then the browser talks to the API on its own
 * origin, so `/api` needs no proxy, no CORS and no build-time API URL - and OAuth
 * redirects can be relative, which is why a wrong `FRONTEND_URL` cannot break them.
 *
 * Shared by `app.ts` (which serves the files) and `utils/redirect.ts` (which
 * decides whether a redirect may be relative), so the two can never disagree.
 */
export const frontendDir = process.env.SERVE_FRONTEND?.trim() || ''
export const spaIndex = frontendDir ? path.join(frontendDir, 'index.html') : ''
export const spaEnabled = Boolean(spaIndex) && fs.existsSync(spaIndex)

export const spaWarning =
  frontendDir && !spaEnabled ? `[app] SERVE_FRONTEND=${frontendDir} has no index.html - SPA hosting disabled.` : null
