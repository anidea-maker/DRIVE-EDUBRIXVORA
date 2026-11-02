/**
 * Mocked tests for the drop-in Edvanta server routes.
 *
 * A fake Express app and an in-memory storage client are used. No database,
 * cloud provider, browser or network request is involved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeStorageStatus, mountEdvantaResourceRoutes } from './express-routes.mjs'

const pass = (_req, _res, next) => next?.()

function fakeApp() {
  const handlers = new Map()
  const register = (method) => (path, ...fns) => handlers.set(`${method} ${path}`, fns[fns.length - 1])
  return {
    handlers,
    app: { get: register('GET'), post: register('POST'), patch: register('PATCH'), delete: register('DELETE') },
  }
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: null,
    redirected: null,
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    redirect(code, url) {
      this.redirected = { code, url }
      return this
    },
    end() {
      return this
    },
  }
}

test('registers student and admin routes with separate guards', () => {
  const { app, handlers } = fakeApp()
  mountEdvantaResourceRoutes(app, { storage: { listResources: async () => ({}) }, requireStudent: pass, requireAdmin: pass })
  assert.ok(handlers.has('GET /api/resources/counts'))
  assert.ok(handlers.has('GET /api/storage-status'))
  assert.ok(handlers.has('GET /api/admin/storage-status'))
  assert.ok(handlers.has('GET /api/admin/9drive/status'))
  assert.ok(handlers.has('GET /api/resources'))
  assert.ok(handlers.has('GET /api/resources/:id/preview'))
  assert.ok(handlers.has('POST /api/resources/bulk-download'))
  assert.ok(handlers.has('POST /api/admin/resources'))
  assert.ok(handlers.has('POST /api/admin/resources/upload'))
  assert.ok(handlers.has('POST /api/resources/upload'))
  assert.ok(handlers.has('POST /api/admin/documents/upload'))
  assert.ok(handlers.has('PATCH /api/admin/resources/:id'))
  assert.ok(handlers.has('GET /api/admin/resources/health'))
})

test('a browser cannot escalate a student listing to audience=admin', async () => {
  let captured = null
  const { app, handlers } = fakeApp()
  mountEdvantaResourceRoutes(app, {
    storage: {
      listResources: async (filters) => {
        captured = filters
        return { resources: [], count: 0 }
      },
    },
    requireStudent: pass,
    requireAdmin: pass,
  })
  const res = fakeRes()
  await handlers.get('GET /api/resources')({ query: { audience: 'admin', visibility: 'private', q: 'biology' }, params: {}, body: {} }, res, () => {})
  assert.equal(captured.audience, 'student')
  assert.equal(captured.q, 'biology')
  assert.equal(captured.visibility, undefined, 'private visibility is not forwarded from a student request')
  assert.equal(res.body.count, 0)
})

test('unsupported preview preserves the download option', async () => {
  const download = { url: 'https://drive.example.com/dl', expiresAt: '2026-11-02T12:00:00.000Z' }
  const { app, handlers } = fakeApp()
  mountEdvantaResourceRoutes(app, {
    storage: {
      getPreviewUrl: async () => ({ unsupported: true, previewMode: 'office', reason: 'Conversion not configured.', mimeType: 'application/msword', download }),
    },
    requireStudent: pass,
    requireAdmin: pass,
  })
  const res = fakeRes()
  await handlers.get('GET /api/resources/:id/preview')({ params: { id: 'r1' }, query: {}, body: {} }, res, () => {})
  assert.equal(res.statusCode, 415)
  assert.equal(res.body.code, 'PREVIEW_UNSUPPORTED')
  assert.equal(res.body.download.url, download.url)
})

test('one failed file does not mark an admin batch successful', async () => {
  const uploaded = []
  const { app, handlers } = fakeApp()
  mountEdvantaResourceRoutes(app, {
    storage: {
      uploadResource: async (input) => {
        uploaded.push(input)
        if (input.fileName === 'broken.pdf') throw Object.assign(new Error('Provider refused the upload.'), { code: 'S3_ACCESS_DENIED' })
        return { resource: { id: 'r1' }, objectKey: 'edvanta/resources/batch-1-0/ok.pdf' }
      },
    },
    requireStudent: pass,
    requireAdmin: pass,
    logger: { error: () => {} },
  })
  const req = {
    params: {},
    query: {},
    body: { resourceMeta: { title: 'Batch notes', category: 'Science', sizeBytes: 10, clientRequestId: 'batch-1' } },
    files: [
      { buffer: Buffer.from('ok'), originalname: 'ok.pdf', mimetype: 'application/pdf' },
      { buffer: Buffer.from('bad'), originalname: 'broken.pdf', mimetype: 'application/pdf' },
    ],
  }
  const res = fakeRes()
  await handlers.get('POST /api/admin/resources')(req, res, () => {})
  assert.equal(res.statusCode, 201)
  assert.equal(res.body.succeeded, 1)
  assert.equal(res.body.failed, 1)
  assert.equal(res.body.results[0].status, 'success')
  assert.equal(res.body.results[1].status, 'failed')
  assert.equal(res.body.results[1].code, 'S3_ACCESS_DENIED')
  assert.equal(uploaded[0].resourceMeta.clientRequestId, 'batch-1-0')
  assert.equal(uploaded[1].resourceMeta.clientRequestId, 'batch-1-1')
})

test('upload aliases accept JSON metadata wrappers and plain multipart fields', async () => {
  const uploaded = []
  const { app, handlers } = fakeApp()
  mountEdvantaResourceRoutes(app, {
    storage: {
      uploadResource: async (input) => {
        uploaded.push(input)
        return { resource: { id: `r${uploaded.length}` }, objectKey: `key-${uploaded.length}` }
      },
    },
    requireStudent: pass,
    requireAdmin: pass,
  })
  const req = {
    params: {},
    query: {},
    body: {
      metadata: JSON.stringify({ title: 'Chapter 3', sizeBytes: '10', clientRequestId: 'alias-batch' }),
      category: 'Science',
      role: 'super_admin',
    },
    files: [{ buffer: Buffer.from('ok'), originalname: 'chapter3.pdf', mimetype: 'application/pdf' }],
  }
  const res = fakeRes()
  await handlers.get('POST /api/resources/upload')(req, res, () => {})
  assert.equal(res.statusCode, 201)
  assert.equal(uploaded.length, 1)
  assert.equal(uploaded[0].resourceMeta.title, 'Chapter 3')
  assert.equal(uploaded[0].resourceMeta.category, 'Science')
  assert.equal(uploaded[0].resourceMeta.clientRequestId, 'alias-batch-0')
  assert.equal(uploaded[0].resourceMeta.role, undefined, 'a browser-supplied role is not forwarded as privilege')
})

test('public counts route hardcodes student audience and never blocks on a cold start', async () => {
  let captured = null
  const { app, handlers } = fakeApp()
  mountEdvantaResourceRoutes(app, {
    storage: {
      getLiveCounts: async (options) => {
        captured = options
        return { counts: { total: 7 }, stale: true, note: 'Storage service is waking up; serving the last known counts.' }
      },
    },
    requireStudent: pass,
    requireAdmin: pass,
  })
  const res = fakeRes()
  await handlers.get('GET /api/resources/counts')(
    { params: {}, query: { audience: 'admin', includeUnavailable: '1' }, body: {} },
    res,
    () => {},
  )
  assert.equal(captured.audience, 'student', 'browser cannot escalate the counts query')
  assert.equal(captured.includeUnavailable, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.counts.total, 7)
  assert.equal(res.body.stale, true)
  assert.equal(res.headers['cache-control'], 'private, max-age=5')
})

test('mergeStorageStatus removes the "not reported yet" state from an admin overview', () => {
  const status = {
    storage: { status: 'connected', provider: '9Drive', reported: true, checkedAt: '2026-11-02T12:00:00.000Z' },
    storageStatus: 'connected',
    reported: true,
  }
  const overview = mergeStorageStatus({ users: 12, resources: 7 }, status)
  assert.equal(overview.users, 12)
  assert.equal(overview.storage.status, 'connected')
  assert.equal(overview.storageStatus, 'connected')
  assert.equal(overview.storageReported, true)
  assert.equal(overview.reported, true)
})

test('admin and public storage-status routes always report a storage field', async () => {
  const { app, handlers } = fakeApp()
  let calls = 0
  const status = {
    storage: {
      status: 'connected',
      provider: '9Drive',
      endpoint: 'https://drive.example.com/api/v1',
      database: { ok: true },
      accounts: [{ ok: true, provider: 's3' }],
      resources: { available: 3, missing: 0, inaccessible: 0, unknown: 0 },
      checkedAt: '2026-11-02T12:00:00.000Z',
      reported: true,
    },
    storageStatus: 'connected',
    reported: true,
  }
  mountEdvantaResourceRoutes(app, {
    storage: {
      getStorageStatus: async () => {
        calls += 1
        return status
      },
    },
    requireStudent: pass,
    requireAdmin: pass,
  })
  const adminRes = fakeRes()
  await handlers.get('GET /api/admin/storage-status')({ params: {}, query: {}, body: {} }, adminRes, () => {})
  assert.equal(adminRes.statusCode, 200)
  assert.equal(adminRes.body.storage.status, 'connected')
  assert.equal(adminRes.body.reported, true)

  const publicRes = fakeRes()
  await handlers.get('GET /api/storage-status')({ params: {}, query: {}, body: {} }, publicRes, () => {})
  assert.equal(publicRes.statusCode, 200)
  assert.equal(publicRes.body.storage.status, 'connected')
  assert.equal(publicRes.body.storage.accounts, undefined, 'public status hides account details')
  assert.equal(publicRes.body.storage.endpoint, undefined, 'public status hides the upstream URL')
  assert.equal(calls, 2)
})
