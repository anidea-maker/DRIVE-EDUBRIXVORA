/**
 * Run with:  node --test examples/other-website/
 *
 * The client is checked against a stubbed fetch, so this proves the wire format
 * (paths, headers, body handling, error mapping) without needing a live key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorage, encodeKey, uniqueKey, StorageError } from './drive-storage.mjs'

const ENDPOINT = 'https://drive.example.com/api/v1'

function recorder(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

test('keys are path-encoded per segment', () => {
  assert.equal(encodeKey('a b/c+d.png'), 'a%20b/c%2Bd.png')
  assert.equal(encodeKey('/leading/slash.txt'), 'leading/slash.txt')
  assert.equal(encodeKey('deep/nested/key.json'), 'deep/nested/key.json')
})

test('unique keys keep the display name but not as identity', () => {
  const first = uniqueKey('uploads', '../../report.pdf')
  const second = uniqueKey('uploads', '../../report.pdf')
  assert.notEqual(first, second)
  assert.match(first, /^uploads\/.+\/report\.pdf$/)
  assert.match(second, /^uploads\/.+\/report\.pdf$/)
  assert.ok(!first.includes('..'))
  assert.ok(!second.includes('..'))
})

test('a prefix namespaces every call, replacing the need for a bucket', async () => {
  const { calls, fetchImpl } = recorder(() => json({ key: 'shop/x.png', sizeBytes: '3', etag: '"abc"', created: true }, { status: 201 }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', prefix: 'shop', fetchImpl })

  await storage.put('x.png', Buffer.from('abc'), { contentType: 'image/png' })
  assert.equal(calls[0].url, `${ENDPOINT}/objects/shop/x.png`)
  assert.equal(calls[0].init.method, 'PUT')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k')
  assert.equal(calls[0].init.headers['Content-Type'], 'image/png')
  assert.equal(calls[0].init.headers['Content-Length'], '3')
})

test('put reports the checksum, etag and whether it created or overwrote', async () => {
  const { fetchImpl } = recorder(() =>
    json({ key: 'a.txt', sizeBytes: '5', checksum: '9b2cf5ee1f', etag: '"9b2cf5ee1f"', mimeType: 'text/plain', created: false }, { status: 200 }),
  )
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
  const result = await storage.put('a.txt', 'hello', { contentType: 'text/plain' })
  assert.deepEqual(result, {
    key: 'a.txt',
    sizeBytes: '5',
    checksum: '9b2cf5ee1f',
    etag: '"9b2cf5ee1f"',
    mimeType: 'text/plain',
    created: false,
  })
})

test('put returns the namespaced key that later calls must use', async () => {
  const { fetchImpl } = recorder(() => json({ key: 'shop/a.txt', sizeBytes: '5', checksum: 'abc123', created: true }, { status: 201 }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', prefix: 'shop', fetchImpl })
  const result = await storage.put('a.txt', 'hello')
  assert.equal(result.key, 'shop/a.txt')
  // A server that reports only a checksum still yields a quoted ETag.
  assert.equal(result.etag, '"abc123"')
  assert.equal(result.mimeType, null)
})

test('put refuses a body whose length it cannot know', async () => {
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl: async () => json({}) })
  await assert.rejects(() => storage.put('a.bin', { pipe() {} }), /Content-Length is known/)
})

test('get returns null for a missing key instead of throwing', async () => {
  const { calls, fetchImpl } = recorder(() => json({ code: 'NO_SUCH_KEY', message: 'no' }, { status: 404 }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
  assert.equal(await storage.get('missing.png'), null)
  assert.equal(calls[0].url, `${ENDPOINT}/objects/missing.png`)
})

test('get returns bytes plus metadata', async () => {
  const { fetchImpl } = recorder(() => new Response(Buffer.from('bytes!'), { status: 200, headers: { 'content-type': 'image/png', etag: '"e1"', 'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT' } }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
  const file = await storage.get('a.png')
  assert.equal(file.body.toString(), 'bytes!')
  assert.equal(file.contentType, 'image/png')
  assert.equal(file.etag, '"e1"')
})

test('head returns null for a missing key', async () => {
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl: async () => new Response(null, { status: 404 }) })
  assert.equal(await storage.head('gone.png'), null)
})

test('remove treats 204 and 404 as success', async () => {
  let status = 204
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl: async () => new Response(null, { status }) })
  assert.equal(await storage.remove('a.png'), true)
  status = 404
  assert.equal(await storage.remove('a.png'), true)
})

test('list sends prefix, delimiter, search, checksum, max-keys and continuation', async () => {
  const { calls, fetchImpl } = recorder(() => json({ objects: [], prefixes: ['shop/icons/'], isTruncated: false, nextContinuationToken: null }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', prefix: 'shop', fetchImpl })
  const page = await storage.list({
    prefix: 'icons/',
    delimiter: '/',
    q: 'biology',
    checksum: 'a'.repeat(32),
    mimeType: 'application/pdf',
    maxKeys: 50,
    token: 'abc',
  })

  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/v1/objects')
  assert.equal(url.searchParams.get('prefix'), 'shop/icons/')
  assert.equal(url.searchParams.get('delimiter'), '/')
  assert.equal(url.searchParams.get('q'), 'biology')
  assert.equal(url.searchParams.get('checksum'), 'a'.repeat(32))
  assert.equal(url.searchParams.get('mimeType'), 'application/pdf')
  assert.equal(url.searchParams.get('max-keys'), '50')
  assert.equal(url.searchParams.get('continuation-token'), 'abc')
  assert.deepEqual(page.prefixes, ['shop/icons/'])
})

test('findDuplicates uses the exact checksum filter', async () => {
  const { calls, fetchImpl } = recorder(() => json({ objects: [], prefixes: [], isTruncated: false, nextContinuationToken: null }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', prefix: 'shop', fetchImpl })
  await storage.findDuplicates('b'.repeat(32))
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('checksum'), 'b'.repeat(32))
})

test('sign posts the scoped key and returns an absolute URL', async () => {
  const { calls, fetchImpl } = recorder(() => json({ key: 'shop/a.png', method: 'GET', url: 'https://drive.example.com/api/public/objects/shop/a.png?u=1&k=api-key%3A1&m=GET&exp=9&sig=s', expiresAt: '2026-01-01T00:00:00.000Z' }, { status: 201 }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', prefix: 'shop', fetchImpl })
  const link = await storage.sign('a.png', { expiresInSeconds: 600 })

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.key, 'shop/a.png')
  assert.equal(body.method, 'GET')
  assert.equal(body.expiresInSeconds, 600)
  assert.match(link.url, /^https:\/\/drive\.example\.com\/api\/public\/objects\/shop\/a\.png\?/)
  assert.equal(new URL(link.url).searchParams.get('k'), 'api-key:1')
})

test('API errors keep the code, message and hint', async () => {
  const { fetchImpl } = recorder(() => json({ code: 'API_KEY_SCOPE_MISSING', message: 'This key has [files:read].', hint: 'Create a new key with the required scope.' }, { status: 403 }))
  const storage = createStorage({ endpoint: ENDPOINT, apiKey: 'k', fetchImpl })
  await assert.rejects(
    () => storage.put('a.txt', 'x'),
    (error) => error instanceof StorageError && error.status === 403 && error.code === 'API_KEY_SCOPE_MISSING' && /required scope/.test(error.hint),
  )
})

test('an HTML answer (wrong endpoint) still reports the status', async () => {
  const { fetchImpl } = recorder(() => new Response('<!doctype html>', { status: 404, headers: { 'content-type': 'text/html' } }))
  const storage = createStorage({ endpoint: 'https://wrong.example.com', apiKey: 'k', fetchImpl })
  await assert.rejects(() => storage.list(), (error) => error.code === 'HTTP_404')
})

test('missing configuration fails loudly at construction', () => {
  assert.throws(() => createStorage({ endpoint: '', apiKey: 'k', fetchImpl: async () => json({}) }), /STORAGE_ENDPOINT/)
  assert.throws(() => createStorage({ endpoint: ENDPOINT, apiKey: '', fetchImpl: async () => json({}) }), /STORAGE_API_KEY/)
})
