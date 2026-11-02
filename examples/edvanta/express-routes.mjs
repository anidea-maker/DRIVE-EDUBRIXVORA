import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

/**
 * Drop-in Express routes for the Edvanta server.
 *
 * `requireStudent` and `requireAdmin` MUST be Edvanta's own server-side session
 * middlewares. Nothing in a request body or header is treated as a role here:
 * student routes hardcode `audience=student`, and admin routes are behind the
 * supplied admin middleware. The storage API key never reaches the browser.
 *
 * Usage (after Edvanta's existing auth setup):
 *
 *   import { createStorage } from './edvanta-storage.mjs'
 *   import { mountEdvantaResourceRoutes } from './express-routes.mjs'
 *   const storage = createStorage()
 *   mountEdvantaResourceRoutes(app, { storage, requireStudent, requireAdmin })
 *
 * The upload route expects Edvanta's existing multipart middleware (multer or
 * equivalent) to have populated `req.file` / `req.files` with buffers.
 */

const STUDENT_FILTERS = [
  'q', 'category', 'subject', 'academicLevel', 'examType', 'provider',
  'mimeType', 'limit', 'cursor', 'order', 'availability', 'status',
]

function errorStatus(error) {
  if (!error) return 500
  if (error.status && error.status >= 400 && error.status < 600) return error.status
  return 502
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      if (res.headersSent) return next(error)
      return res.status(errorStatus(error)).json({
        code: error?.code ?? 'STORAGE_UPSTREAM_ERROR',
        message: error?.message ?? 'The storage service could not complete this request.',
        hint: error?.hint ?? null,
      })
    }
  }
}

function parseMeta(req) {
  const raw = req.body?.resourceMeta ?? req.body?.meta
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      throw Object.assign(new Error('resourceMeta must be valid JSON.'), { code: 'RESOURCE_META_INVALID', status: 400 })
    }
  }
  return raw && typeof raw === 'object' ? raw : {}
}

export function mountEdvantaResourceRoutes(app, { storage, requireStudent, requireAdmin, logger = console } = {}) {
  if (!storage) throw new Error('mountEdvantaResourceRoutes needs a storage client.')
  if (typeof requireStudent !== 'function' || typeof requireAdmin !== 'function') {
    throw new Error('mountEdvantaResourceRoutes needs Edvanta server-side requireStudent and requireAdmin middlewares.')
  }

  /* ------------------------------ public counts ---------------------------- */

  /**
   * Landing-page counts are public metadata. Edvanta's server still holds the
   * storage API key; `audience` is hardcoded so a browser cannot ask for admin
   * counts. A stale response is still HTTP 200: the page must not show a
   * minute-long "loading the live counts" notice while Render wakes up.
   */
  app.get('/api/resources/counts', wrap(async (req, res) => {
    const counts = await storage.getLiveCounts({
      audience: 'student',
      includeUnavailable: req.query.includeUnavailable === '1',
    })
    res.setHeader('Cache-Control', counts.stale ? 'private, max-age=5' : 'private, max-age=30')
    return res.json(counts)
  }))

  /* ------------------------------ student side ----------------------------- */

  app.get('/api/resources', requireStudent, wrap(async (req, res) => {
    const filters = { audience: 'student' }
    for (const key of STUDENT_FILTERS) {
      if (typeof req.query[key] === 'string') filters[key] = req.query[key]
    }
    const page = await storage.listResources(filters)
    return res.json(page)
  }))

  app.get('/api/resources/:id', requireStudent, wrap(async (req, res) => {
    const { resource } = await storage.getResource(req.params.id, { audience: 'student' })
    return res.json({ resource })
  }))

  app.get('/api/resources/:id/preview', requireStudent, wrap(async (req, res) => {
    const preview = await storage.getPreviewUrl(req.params.id, { audience: 'student' })
    if (preview.unsupported) {
      return res.status(415).json({
        code: 'PREVIEW_UNSUPPORTED',
        message: preview.reason,
        previewMode: preview.previewMode,
        mimeType: preview.mimeType,
        download: preview.download,
      })
    }
    if (req.query.redirect === '1') return res.redirect(302, preview.url)
    res.setHeader('Cache-Control', 'private, no-store')
    return res.json({
      url: preview.url,
      expiresAt: preview.expiresAt,
      mechanism: preview.mechanism,
      previewMode: preview.previewMode,
    })
  }))

  app.get('/api/resources/:id/download', requireStudent, wrap(async (req, res) => {
    const download = await storage.getDownloadUrl(req.params.id, { audience: 'student' })
    if (req.query.url === '1') return res.json(download)
    return res.redirect(302, download.url)
  }))

  app.post('/api/resources/bulk-download', requireStudent, wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (ids.length === 0) return res.status(400).json({ code: 'BULK_EMPTY', message: 'Select at least one resource.' })
    const bulk = await storage.bulkDownload(ids, { audience: 'student' })
    const upstream = bulk.response
    for (const header of ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options']) {
      const value = upstream.headers.get(header)
      if (value) res.setHeader(header, value)
    }
    res.setHeader('X-Resource-Bulk-Error-Count', String(bulk.errorCount))
    res.setHeader('X-Resource-Bulk-Skipped', bulk.skipped.join(','))
    res.status(upstream.status)
    if (!upstream.body) return res.end()
    const stream = Readable.fromWeb(upstream.body)
    stream.on('error', (error) => {
      logger.error?.('[edvanta] bulk download stream failed:', error.message)
      if (!res.headersSent) res.status(502).json({ code: 'BULK_STREAM_FAILED', message: error.message })
      else res.destroy(error)
    })
    return stream.pipe(res)
  }))

  /* ------------------------------- admin side ------------------------------ */

  app.post('/api/admin/resources', requireAdmin, wrap(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : []
    if (files.length === 0) return res.status(400).json({ code: 'RESOURCE_FILE_REQUIRED', message: 'Attach at least one file.' })
    const baseMeta = parseMeta(req)
    const results = []
    for (const [index, file] of files.entries()) {
      const clientRequestId = baseMeta.clientRequestId
        ? `${baseMeta.clientRequestId}-${index}`
        : randomUUID()
      try {
        const uploaded = await storage.uploadResource({
          file: file.buffer ?? file,
          fileName: file.originalname ?? file.name,
          mimeType: file.mimetype ?? file.type,
          resourceMeta: { ...baseMeta, title: baseMeta.title ?? file.originalname ?? file.name ?? `Resource ${index + 1}`, clientRequestId },
        })
        results.push({ fileName: file.originalname ?? file.name, status: 'success', resource: uploaded.resource, objectKey: uploaded.objectKey })
      } catch (error) {
        results.push({ fileName: file.originalname ?? file.name, status: 'failed', code: error?.code ?? 'UPLOAD_FAILED', message: error?.message ?? 'Upload failed.' })
      }
    }
    const succeeded = results.filter((entry) => entry.status === 'success').length
    // One failed file never marks the whole batch successful.
    return res.status(succeeded > 0 ? 201 : 502).json({ results, succeeded, failed: results.length - succeeded })
  }))

  app.patch('/api/admin/resources/:id', requireAdmin, wrap(async (req, res) => {
    const { resource } = await storage.patchResource(req.params.id, parseMeta(req))
    return res.json({ resource })
  }))

  app.delete('/api/admin/resources/:id', requireAdmin, wrap(async (req, res) => {
    const result = await storage.deleteResource(req.params.id, { permanent: req.query.permanent === '1' })
    return res.json(result)
  }))

  app.post('/api/admin/resources/:id/verify', requireAdmin, wrap(async (req, res) => {
    return res.json(await storage.verifyResource(req.params.id))
  }))

  app.post('/api/admin/resources/sync', requireAdmin, wrap(async (req, res) => {
    return res.json(await storage.syncResources({
      limit: Number(req.body?.limit ?? 50),
      cursor: req.body?.cursor,
      order: req.body?.order ?? 'newest',
    }))
  }))

  app.get('/api/admin/resources/health', requireAdmin, wrap(async (_req, res) => {
    return res.json(await storage.health())
  }))
}
