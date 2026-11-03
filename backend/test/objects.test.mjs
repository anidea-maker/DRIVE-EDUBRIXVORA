/**
 * Mocked website/object-API tests. No database server, Google Drive, S3 or HTTP server is
 * contacted; every helper below is pure or uses an in-memory fake store.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

process.env.DATABASE_URL ||= 'file:./test/.tmp/test.db'
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY ||= 'y'.repeat(40)
process.env.NODE_ENV = 'test'

const require = createRequire(import.meta.url)
const shared = require('../dist/modules/public-api/objects.shared.js')
const safeErrors = require('../dist/modules/public-api/safe-errors.js')
const rateLimit = require('../dist/modules/public-api/rate-limit.js')
const apiKey = require('../dist/middleware/api-key.middleware.js')
const signing = require('../dist/modules/public-api/object-signing.js')
const roles = require('../dist/modules/auth/roles.js')

test('API keys are read from the Authorization header only', () => {
  const req = (header, query = {}) => ({ header: (name) => (name === 'Authorization' ? header : undefined), query })
  assert.deepEqual(apiKey.readBearerKey(req('Bearer 9d_live_secret')), { rawKey: '9d_live_secret', problem: null })
  assert.equal(apiKey.readBearerKey(req(undefined)).problem, 'missing')
  assert.equal(apiKey.readBearerKey(req('Bearer ')).problem, 'missing')
  assert.equal(apiKey.readBearerKey(req('Bearer 9d_live_secret', { api_key: '9d_live_query' })).problem, 'query')
  assert.equal(apiKey.readBearerKey(req(undefined, { api_key: '9d_live_query' })).problem, 'query')
})

test('persistent rate-limit store is shared and falls back safely', async () => {
  const counts = new Map()
  const store = {
    async upsert({ where }) {
      const id = `${where.apiKeyId_windowStart.apiKeyId}:${where.apiKeyId_windowStart.windowStart.toISOString()}`
      const next = (counts.get(id) ?? 0) + 1
      counts.set(id, next)
      return { count: next }
    },
  }
  const now = new Date('2026-11-02T12:00:00.000Z').getTime()
  const options = { storage: 'database', now, store }
  const first = await rateLimit.takeApiKeyToken('key-1', 2, options)
  const second = await rateLimit.takeApiKeyToken('key-1', 2, options)
  const third = await rateLimit.takeApiKeyToken('key-1', 2, options)
  assert.equal(first.allowed, true)
  assert.equal(second.allowed, true)
  assert.equal(third.allowed, false)
  assert.equal(third.remaining, 0)

  const broken = await rateLimit.takeApiKeyToken('key-fallback', 1, {
    storage: 'database',
    now,
    store: { upsert: async () => { throw new Error('database down') } },
  })
  assert.equal(broken.allowed, true, 'a limiter outage must not become a hard API outage')
})

test('provider errors are reduced to safe codes and never leak bucket details', () => {
  const error = Object.assign(new Error('AccessDenied for bucket private-bucket-name at https://s3.example.com with token ABC123'), { code: 'S3_ACCESS_DENIED' })
  const problem = safeErrors.safeStorageProblem(error)
  assert.equal(problem.code, 'S3_ACCESS_DENIED')
  assert.equal(problem.status, 502)
  assert.ok(!problem.message.includes('private-bucket-name'))
  assert.ok(!problem.message.includes('ABC123'))
  assert.match(problem.message, /Reconnect or update/)

  const unknown = safeErrors.safeStorageProblem(new Error('raw /internal/path with Bearer secret-token'), 'INTERNAL_SERVER_ERROR')
  assert.equal(unknown.code, 'INTERNAL_SERVER_ERROR')
  assert.equal(unknown.status, 500)
  assert.ok(!unknown.message.includes('/internal/path'))
  assert.ok(!unknown.message.includes('secret-token'))
})

test('object keys reject traversal/control characters and support same display names', () => {
  assert.equal(shared.objectKeyProblem('../secret.txt'), 'dot_segment')
  assert.equal(shared.objectKeyProblem('a//b.txt'), 'empty_segment')
  assert.equal(shared.objectKeyProblem('a\u0000b.txt'), 'control_char')
  assert.equal(shared.objectKeyProblem('folder/report.pdf'), null)
  const first = shared.buildUniqueObjectKey('uploads', '../../report.pdf', 'id-1')
  const second = shared.buildUniqueObjectKey('uploads', '../../report.pdf', 'id-2')
  assert.notEqual(first, second)
  assert.ok(first.endsWith('/report.pdf'))
  assert.ok(second.endsWith('/report.pdf'))
  assert.equal(shared.objectKeyProblem(first), null)
  assert.equal(shared.objectKeyProblem(second), null)
})

test('safe inline preview is allowlisted; risky types are forced to download', () => {
  assert.equal(shared.safeInlineMimeType('application/pdf'), true)
  assert.equal(shared.safeInlineMimeType('image/png'), true)
  assert.equal(shared.safeInlineMimeType('text/plain; charset=utf-8'), true)
  assert.equal(shared.safeInlineMimeType('image/svg+xml'), false)
  assert.equal(shared.safeInlineMimeType('text/html'), false)
  assert.equal(shared.safeInlineMimeType('application/javascript'), false)
  assert.equal(shared.safeInlineMimeType('application/octet-stream'), false)
  assert.equal(shared.safeInlineMimeType(null), false)
})

test('object listing supports search, exact checksum and keyset continuation', () => {
  const where = shared.buildObjectListWhere({
    userId: 'user-1',
    prefix: 'uploads/',
    continuation: { after: 'uploads/a.txt', skippedPrefix: null },
    q: 'biology',
    checksum: 'a'.repeat(32),
    mimeType: 'application/pdf',
  })
  assert.equal(where.userId, 'user-1')
  assert.equal(where.status, 'active')
  assert.equal(where.objectKey.startsWith, 'uploads/')
  assert.equal(where.objectKey.gt, 'uploads/a.txt')
  assert.equal(where.AND.length, 3)
  assert.ok(where.AND[0].OR.some((entry) => entry.name?.contains === 'biology'))
  assert.deepEqual(where.AND[1], { checksum: 'a'.repeat(32) })
  assert.deepEqual(where.AND[2], { mimeType: 'application/pdf' })
})

test('signed URLs require the signing identity and bind it into the HMAC', () => {
  const key = 'uploads/report.pdf'
  const keyId = 'api-key:key-1'
  const expiresAt = Math.floor(Date.now() / 1000) + 300
  const signature = signing.signObjectUrl('GET', 'user-1', keyId, key, expiresAt)
  assert.equal(signing.verifyObjectUrl({ method: 'GET', userId: 'user-1', keyId, key, expiresAt, signature }), null)
  assert.equal(signing.verifyObjectUrl({ method: 'GET', userId: 'user-1', keyId: undefined, key, expiresAt, signature }), 'identity')
  assert.equal(signing.verifyObjectUrl({ method: 'GET', userId: 'user-1', keyId: 'api-key:other', key, expiresAt, signature }), 'invalid')
})

test('new accounts are least-privileged by default', () => {
  assert.equal(roles.DEFAULT_USER_ROLE, 'visitor')
  assert.equal(roles.canManageResources(roles.DEFAULT_USER_ROLE), false)
})
