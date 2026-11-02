/**
 * Mocked wire-format tests for the Edvanta server-side client.
 *
 * No network, no MySQL, no Google Drive and no S3 are used. A stubbed fetch
 * returns canned EduBrixVora responses. Live integration must be verified with
 * real credentials using the checklist in ../../docs/EDVANTA-INTEGRATION.md.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStorage, normalizeStorageEndpoint, StorageError } from './edvanta-storage.mjs'

const ENDPOINT = 'https://drive.example.com/api/v1'
const API_KEY = '9d_live_test'

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function storageWith(handler, overrides = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { storage: createStorage({ endpoint: ENDPOINT, apiKey: API_KEY, fetchImpl, ...overrides }), calls }
}

test('configuration comes from server-side env only', () => {
  assert.throws(() => createStorage({ endpoint: '', apiKey: '', fetchImpl: async () => jsonResponse({}) }), /STORAGE_ENDPOINT/)
  const previous = { ...process.env }
  process.env.STORAGE_ENDPOINT = ENDPOINT
  process.env.STORAGE_API_KEY = API_KEY
  const storage = createStorage({ fetchImpl: async () => jsonResponse({ resources: [] }) })
  assert.equal(storage.endpoint, ENDPOINT)
  process.env = previous
})

test('listResources sends student audience, filters and the bearer key', async () => {
  const { storage, calls } = storageWith(async () => jsonResponse({ resources: [], hasMore: false, nextCursor: null }))
  await storage.listResources({ q: 'biology', subject: 'Biology', limit: 25, cursor: 'abc' })
  const { url, init } = calls[0]
  assert.equal(init.method, 'GET')
  assert.equal(init.headers.get('authorization'), `Bearer ${API_KEY}`)
  const parsed = new URL(url)
  assert.equal(parsed.pathname, '/api/v1/resources')
  assert.equal(parsed.searchParams.get('audience'), 'student')
  assert.equal(parsed.searchParams.get('q'), 'biology')
  assert.equal(parsed.searchParams.get('subject'), 'Biology')
  assert.equal(parsed.searchParams.get('limit'), '25')
  assert.equal(parsed.searchParams.get('cursor'), 'abc')
})

test('getResource and access URLs encode the stable id', async () => {
  const { storage, calls } = storageWith(async () => jsonResponse({ resource: { id: 'id 1' } }))
  await storage.getResource('id 1')
  await storage.getAccess('id 1', { ttlSeconds: 300 })
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/resources/id%201')
  assert.equal(new URL(calls[1].url).pathname, '/api/v1/resources/id%201/access')
  assert.equal(new URL(calls[1].url).searchParams.get('ttlSeconds'), '300')
})

test('unsupported preview returns a download URL instead of throwing', async () => {
  const download = { url: 'https://drive.example.com/download', expiresAt: '2026-11-02T12:00:00.000Z' }
  const { storage } = storageWith(async () =>
    jsonResponse({ code: 'PREVIEW_UNSUPPORTED', message: 'Word files need conversion.', previewMode: 'office', mimeType: 'application/msword', download }, { status: 415 }),
  )
  const preview = await storage.getPreviewUrl('r1')
  assert.equal(preview.unsupported, true)
  assert.equal(preview.previewMode, 'office')
  assert.equal(preview.download.url, download.url)
})

test('download URL and bulk ZIP headers are surfaced', async () => {
  const { storage, calls } = storageWith(async (url) =>
    url.endsWith('/bulk-download')
      ? new Response('zip-bytes', { status: 200, headers: { 'content-type': 'application/zip', 'x-resource-bulk-error-count': '2', 'x-resource-bulk-skipped': 'a,b' } })
      : jsonResponse({ url: 'https://drive.example.com/dl', expiresAt: '2026-11-02T12:00:00.000Z' }),
  )
  const download = await storage.getDownloadUrl('r1')
  assert.equal(download.url, 'https://drive.example.com/dl')
  const bulk = await storage.bulkDownload(['r1', 'r2', 'r3'])
  assert.equal(bulk.errorCount, 2)
  assert.deepEqual(bulk.skipped, ['a', 'b'])
  assert.equal(bulk.response.headers.get('content-type'), 'application/zip')
  const body = new URL(calls[1].url)
  assert.equal(body.pathname, '/api/v1/resources/bulk-download')
  assert.deepEqual(JSON.parse(calls[1].init.body), { ids: ['r1', 'r2', 'r3'], audience: 'student' })
})

test('uploadResource builds multipart with resourceMeta before the file part', async () => {
  const { storage, calls } = storageWith(async () => jsonResponse({ resource: { id: 'r1' }, objectKey: 'edvanta/resources/req-12345678/a.pdf' }, { status: 201 }))
  const result = await storage.uploadResource({
    file: Buffer.from('hello'),
    fileName: 'notes.pdf',
    mimeType: 'application/pdf',
    resourceMeta: { title: 'Notes', category: 'Science', sizeBytes: 5, clientRequestId: 'req-12345678' },
  })
  assert.equal(result.resource.id, 'r1')
  const form = calls[0].init.body
  assert.ok(form instanceof FormData)
  const meta = JSON.parse(form.get('resourceMeta'))
  assert.equal(meta.sizeBytes, '5')
  assert.equal(meta.clientRequestId, 'req-12345678')
  assert.equal(meta.fileName, 'notes.pdf')
  assert.equal(form.get('file').name, 'notes.pdf')
  assert.ok(!calls[0].init.headers.has('content-type'), 'fetch must set the multipart boundary itself')
})

test('uploadResource rejects a file with no declared size', async () => {
  const { storage } = storageWith(async () => jsonResponse({}))
  await assert.rejects(
    () => storage.uploadResource({ file: Buffer.from(''), fileName: 'empty.bin', resourceMeta: { title: 'Empty' } }),
    (error) => error instanceof StorageError && error.code === 'STORAGE_INPUT_INVALID',
  )
})

test('upstream JSON errors keep status, code and hint; network errors map to 502', async () => {
  const bad = storageWith(async () => jsonResponse({ code: 'API_KEY_SCOPE_MISSING', message: 'Needs read scope.', hint: 'Create a new key.' }, { status: 403 }))
  await assert.rejects(
    () => bad.storage.listResources(),
    (error) => error instanceof StorageError && error.status === 403 && error.code === 'API_KEY_SCOPE_MISSING' && error.hint.includes('new key'),
  )
  const offline = storageWith(async () => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(
    () => offline.storage.health(),
    (error) => error instanceof StorageError && error.code === 'STORAGE_UPSTREAM_UNAVAILABLE' && error.status === 502,
  )
})

test('getLiveCounts never blocks the page: fresh, then stale fallback', async () => {
  let healthy = true
  const calls = []
  const storage = createStorage({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (!healthy) throw new TypeError('fetch failed')
      return jsonResponse({
        counts: { total: 12, available: 11, missing: 1, inaccessible: 0, unknown: 0, byCategory: { Science: 12 }, bySubject: {}, byProvider: {} },
        audience: 'student',
        includeUnavailable: false,
        generatedAt: '2026-11-02T12:00:00.000Z',
        ttlSeconds: 30,
        cached: false,
      })
    },
  })
  const fresh = await storage.getLiveCounts({ timeoutMs: 50 })
  assert.equal(fresh.stale, false)
  assert.equal(fresh.counts.total, 12)
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/resources/counts')
  assert.equal(new URL(calls[0].url).searchParams.get('audience'), 'student')

  healthy = false
  const stale = await storage.getLiveCounts({ timeoutMs: 50 })
  assert.equal(stale.stale, true)
  assert.equal(stale.counts.total, 12)
  assert.match(stale.note, /waking up/i)
})

test('getLiveCounts returns an empty stale shape when there is no cached answer', async () => {
  const storage = createStorage({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    fetchImpl: async () => {
      throw new TypeError('fetch failed')
    },
  })
  const result = await storage.getLiveCounts({ timeoutMs: 50, includeUnavailable: true })
  assert.equal(result.stale, true)
  assert.equal(result.generatedAt, null)
  assert.equal(result.counts.total, 0)
  assert.deepEqual(result.counts.byCategory, {})
  assert.equal(result.error, 'STORAGE_UPSTREAM_UNAVAILABLE')
})

test('normalizeStorageEndpoint turns bare origins and /api into /api/v1', () => {
  const expected = 'https://drive-edubrixvora-1.onrender.com/api/v1'
  assert.equal(normalizeStorageEndpoint('https://drive-edubrixvora-1.onrender.com/'), expected)
  assert.equal(normalizeStorageEndpoint('https://drive-edubrixvora-1.onrender.com/api'), expected)
  assert.equal(normalizeStorageEndpoint('https://drive-edubrixvora-1.onrender.com/api/v1'), expected)
  assert.equal(normalizeStorageEndpoint('drive-edubrixvora-1.onrender.com'), expected)
  assert.equal(normalizeStorageEndpoint('https://drive.example.com/v1'), 'https://drive.example.com/api/v1')
  // A pasted credential/query must never survive normalisation.
  assert.equal(normalizeStorageEndpoint('https://user:pass@drive.example.com/api?key=secret'), 'https://drive.example.com/api/v1')
  assert.equal(normalizeStorageEndpoint(''), '')
})

test('existing NINE_DRIVE_API_URL and NINE_DRIVE_API_KEY are used without renaming', async () => {
  const keys = [
    'STORAGE_ENDPOINT', 'STORAGE_API_KEY', 'STORAGE_TIMEOUT_MS',
    'NINE_DRIVE_API_URL', 'NINE_DRIVE_URL', 'NINE_DRIVE_BASE_URL',
    'NINE_DRIVE_API_KEY', 'NINE_DRIVE_TIMEOUT_MS',
  ]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  try {
    process.env.NINE_DRIVE_API_URL = 'https://drive-edubrixvora-1.onrender.com/api'
    process.env.NINE_DRIVE_API_KEY = '9d_live_from_nine_drive_vars'
    const calls = []
    const storage = createStorage({
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse({ status: 'ok' })
      },
    })
    assert.equal(storage.endpoint, 'https://drive-edubrixvora-1.onrender.com/api/v1')
    await storage.health()
    assert.equal(new URL(calls[0].url).pathname, '/api/v1/resources/health')
    assert.equal(calls[0].init.headers.get('authorization'), 'Bearer 9d_live_from_nine_drive_vars')
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
})

test('getStorageStatus always reports a storage object, connected or unavailable', async () => {
  const healthy = {
    status: 'ok',
    storage: {
      status: 'connected',
      provider: '9Drive',
      database: { ok: true },
      accounts: [{ ok: true, provider: 's3' }],
      resources: { available: 5, missing: 0, inaccessible: 0, unknown: 0 },
      checkedAt: '2026-11-02T12:00:00.000Z',
      reported: true,
    },
    storageStatus: 'connected',
    reported: true,
  }
  const { storage, calls } = storageWith(async () => jsonResponse(healthy))
  const ok = await storage.getStorageStatus({ timeoutMs: 50 })
  assert.equal(ok.reported, true)
  assert.equal(ok.storage.status, 'connected')
  assert.equal(ok.storage.endpoint, ENDPOINT)
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/storage-status')

  const degraded = storageWith(async () => jsonResponse({
    status: 'degraded',
    storage: { ...healthy.storage, status: 'degraded' },
    storageStatus: 'degraded',
    reported: true,
  }, { status: 503 }))
  const bad = await degraded.storage.getStorageStatus({ timeoutMs: 50 })
  assert.equal(bad.reported, true)
  assert.equal(bad.storage.status, 'degraded')

  const offline = createStorage({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    fetchImpl: async () => {
      throw new TypeError('fetch failed')
    },
  })
  const unavailable = await offline.getStorageStatus({ timeoutMs: 50 })
  assert.equal(unavailable.reported, true)
  assert.equal(unavailable.storage.status, 'unavailable')
  assert.equal(unavailable.storage.endpoint, ENDPOINT)
  assert.equal(unavailable.storage.error, 'STORAGE_UPSTREAM_UNAVAILABLE')
})

test('patch, delete, verify, sync and health use the documented verbs and paths', async () => {
  const { storage, calls } = storageWith(async () => jsonResponse({ status: 'ok' }))
  await storage.patchResource('r1', { title: 'Renamed' })
  await storage.deleteResource('r1', { permanent: true })
  await storage.verifyResource('r1')
  await storage.syncResources({ limit: 10, cursor: 'cursor-1' })
  await storage.health()
  assert.deepEqual(
    calls.map((call) => [call.init.method, new URL(call.url).pathname]),
    [
      ['PATCH', '/api/v1/resources/r1'],
      ['DELETE', '/api/v1/resources/r1'],
      ['POST', '/api/v1/resources/r1/verify'],
      ['POST', '/api/v1/resources/sync'],
      ['GET', '/api/v1/resources/health'],
    ],
  )
  assert.equal(new URL(calls[1].url).searchParams.get('permanent'), '1')
})
