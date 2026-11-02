/**
 * End-to-end tests for the 9Drive storage API.
 *
 * These run the **real Express application** (`dist/app.js`) over HTTP. Two
 * things are substituted, and only two:
 *
 *  - the database: an in-memory stand-in (see `helpers/fake-prisma.mjs`), and
 *  - the S3-compatible provider: a local HTTP server implementing the small part
 *    of the S3 protocol the backend uses (see `helpers/fake-s3.mjs`).
 *
 * Everything else is production code: the routers, the API-key middleware, the
 * scope checks, the server-side role checks, the upload/verify/stream/delete
 * paths, the serializer and the error handler. Real bytes travel over real
 * HTTP, so a "201 Created" here means the object really exists at the provider
 * and was really confirmed there.
 *
 * No Google Drive, no cloud bucket and no MySQL are contacted.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import path from 'node:path'

import { createFakePrisma } from './helpers/fake-prisma.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ||= 'mysql://test:test@127.0.0.1:3306/testdb'
process.env.JWT_ACCESS_SECRET ||= 'j'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY ||= 'k'.repeat(40)
process.env.FRONTEND_URL = 'http://localhost:5173'
process.env.API_CORS_ORIGINS = ''
// Small on purpose: the size-limit test then costs a few kB instead of 5 GB.
process.env.MAX_UPLOAD_BYTES = '65536'
process.env.API_RATE_LIMIT_PER_MINUTE = '600'
process.env.OBJECT_URL_SIGNING_SECRET = 'e2e-signing-secret-for-tests-only'

const require = createRequire(import.meta.url)
const prismaModulePath = require.resolve('../dist/config/prisma.js')

const prisma = createFakePrisma()

// Swap the database out before anything imports the app: every module that
// imports `dist/config/prisma.js` then receives this instance instead.
require.cache[prismaModulePath] = {
  id: prismaModulePath,
  filename: prismaModulePath,
  path: path.dirname(prismaModulePath),
  exports: { prisma },
  loaded: true,
  children: [],
  paths: [],
}

const { app } = require('../dist/app.js')
const { encryptText, hashToken } = require('../dist/utils/crypto.js')

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const KEYS = {
  full: '9d_live_e2e_full_scope_key',
  readOnly: '9d_live_e2e_read_only_key',
  revoked: '9d_live_e2e_revoked_key',
  otherUser: '9d_live_e2e_other_user_key',
}

const SMALL_BODY = 'hello edvanta'
const SMALL_MD5 = createHash('md5').update(SMALL_BODY).digest('hex')

let s3
let server
let base

const auth = (key) => ({ Authorization: `Bearer ${key}` })

before(async () => {
  s3 = await startFakeS3({ buckets: ['edvanta-bucket'] })

  // --- Owner (administrator) -------------------------------------------------
  prisma._store.user.push({
    id: 'user-1',
    name: 'Storage Owner',
    email: 'owner@example.com',
    passwordHash: 'not-a-real-hash',
    status: 'active',
    role: 'admin',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // --- A second tenant, used to prove cross-tenant isolation -----------------
  prisma._store.user.push({
    id: 'user-2',
    name: 'Other Tenant',
    email: 'other@example.com',
    passwordHash: 'not-a-real-hash',
    status: 'active',
    role: 'admin',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // --- Nine Google Drive accounts, as in the production deployment -----------
  for (let index = 1; index <= 9; index += 1) {
    const id = `acct-drive-${index}`
    prisma._store.connectedAccount.push({
      id,
      userId: 'user-1',
      provider: 'google_drive',
      providerAccountId: `drive-${index}`,
      email: `drive${index}@example.com`,
      displayName: `Drive ${index}`,
      status: 'connected',
      scopes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    prisma._store.storageAccount.push({
      id: `storage-drive-${index}`,
      connectedAccountId: id,
      // 15 GiB each, as Google reports per account.
      totalBytes: BigInt(15 * 1024 * 1024 * 1024),
      usedBytes: 0n,
      availableBytes: BigInt(15 * 1024 * 1024 * 1024),
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  // --- One S3-compatible bucket, pointed at the local fake -------------------
  const s3AccountId = 'acct-s3-1'
  prisma._store.connectedAccount.push({
    id: s3AccountId,
    userId: 'user-1',
    provider: 's3',
    providerAccountId: 's3-1',
    email: 's3@example.com',
    displayName: 'S3 Bucket',
    status: 'connected',
    scopes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  prisma._store.s3StorageConfig.push({
    id: 's3-config-1',
    userId: 'user-1',
    connectedAccountId: s3AccountId,
    name: 'Edvanta Bucket',
    bucket: 'edvanta-bucket',
    region: 'us-east-1',
    endpoint: s3.url,
    accessKeyIdEncrypted: encryptText('AKIAE2ETESTKEY'),
    secretAccessKeyEncrypted: encryptText('e2e-secret-access-key'),
    forcePathStyle: true,
    prefix: '9drive',
    quotaBytes: BigInt(1024 * 1024 * 1024),
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  prisma._store.storageAccount.push({
    id: 'storage-s3-1',
    connectedAccountId: s3AccountId,
    totalBytes: BigInt(1024 * 1024 * 1024),
    usedBytes: 0n,
    availableBytes: BigInt(1024 * 1024 * 1024),
    lastSyncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  /**
   * The upload routing policy is the deployment's existing provider-selection
   * logic, left untouched. With nine Drive accounts holding more free space than
   * the one bucket, the default `most_available` mode would choose Google
   * Drive (which cannot be reached without real OAuth credentials), so the
   * policy is pinned to the bucket the same way an operator would in Settings.
   * Selection still runs through the production code path.
   */
  prisma._store.uploadRoutingPolicy.push({
    id: 'policy-1',
    userId: 'user-1',
    mode: 'priority',
    priorityAccountIds: [s3AccountId],
    roundRobinCursor: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // --- API keys: stored hashed, exactly as the real middleware expects -------
  const addKey = (id, token, userId, scopes, extra = {}) => {
    prisma._store.apiKey.push({
      id,
      userId,
      name: id,
      keyPrefix: '9d_live',
      keyHash: hashToken(token),
      scopes,
      status: 'active',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    })
  }

  addKey('key-full', KEYS.full, 'user-1', ['files:read', 'files:write', 'files:delete'])
  addKey('key-read', KEYS.readOnly, 'user-1', ['files:read'])
  addKey('key-revoked', KEYS.revoked, 'user-1', ['files:read'], { status: 'revoked', revokedAt: new Date() })
  addKey('key-other', KEYS.otherUser, 'user-2', ['files:read', 'files:write', 'files:delete'])

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await s3.close()
})

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const url = (route) => `${base}${route}`

async function getJson(route, options = {}) {
  const response = await fetch(url(route), options)
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, headers: response.headers, body }
}

const settleBackgroundWork = () => new Promise((resolve) => setTimeout(resolve, 150))

/* -------------------------------------------------------------------------- */
/*  Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('health, readiness and discovery', () => {
  test('GET /health reports the process, the build and a reported storage status', async () => {
    const { status, body } = await getJson('/health')
    assert.equal(status, 200)
    assert.equal(body.status, 'ok')
    assert.equal(typeof body.uptimeSeconds, 'number')
    assert.equal(body.storage.reported, true)
    assert.equal(body.storage.provider, '9drive')
    assert.equal(body.storage.accounts.connected, 10, 'nine Google Drive accounts plus one S3 bucket')
    assert.equal(body.storage.accounts.googleDrive, 9)
    assert.equal(body.storage.accounts.s3, 1)
    assert.equal(body.storage.upload.available, true)
  })

  test('GET /ready proves the database and migrations are reachable', async () => {
    const { status, body } = await getJson('/ready')
    assert.equal(status, 200)
    assert.equal(body.status, 'ok')
    assert.equal(body.database, 'ok')
    assert.equal(body.migrations, '17')
    assert.equal(body.storageReported, true)
  })

  test('GET /api/v1 is a machine-readable index and names its auth scheme', async () => {
    const { status, body } = await getJson('/api/v1')
    assert.equal(status, 200)
    assert.equal(body.service, '9Drive Storage API')
    assert.equal(body.auth.type, 'bearer')
    assert.equal(body.auth.headerOnly, true)
    assert.deepEqual(
      body.auth.scopes.map((scope) => scope.id),
      ['files:read', 'files:write', 'files:delete'],
    )
    assert.equal(body.limits.maxUploadBytes, '65536')

    const listed = body.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    for (const required of [
      'PUT /api/v1/objects/:key',
      'GET /api/v1/objects/:key',
      'HEAD /api/v1/objects/:key',
      'DELETE /api/v1/objects/:key',
      'GET /api/v1/objects',
      'POST /api/v1/objects/sign',
      'GET /api/v1/files/:id',
      'GET /api/v1/files/:id/content',
      'POST /api/v1/files',
      'DELETE /api/v1/files/:id',
      'GET /api/v1/usage',
    ]) {
      assert.ok(listed.includes(required), `the index must advertise ${required}`)
    }
  })

  test('GET /api/v1/storage-status reports status and never a credential', async () => {
    const { status, body } = await getJson('/api/v1/storage-status')
    assert.equal(status, 200)
    assert.equal(body.reported, true)
    assert.equal(body.storage.reported, true)
    assert.equal(['connected', 'degraded', 'unavailable'].includes(body.storageStatus), true)
    const serialised = JSON.stringify(body)
    for (const secret of ['accessKeyId', 'secretAccessKey', 'refreshTokenEncrypted', 'AKIAE2ETESTKEY', 'e2e-secret-access-key']) {
      assert.equal(serialised.includes(secret), false, `storage-status must not contain ${secret}`)
    }
  })
})

describe('authentication and authorization', () => {
  test('a request with no key is rejected with 401', async () => {
    const { status, body } = await getJson('/api/v1/files')
    assert.equal(status, 401)
    assert.equal(body.code, 'API_KEY_REQUIRED')
  })

  test('an unknown key is rejected with 401', async () => {
    const { status, body } = await getJson('/api/v1/files', { headers: auth('9d_live_not_a_real_key') })
    assert.equal(status, 401)
    assert.equal(body.code, 'API_KEY_INVALID')
  })

  test('a key in the query string is refused: URLs leak through logs and Referer', async () => {
    const { status, body } = await getJson(`/api/v1/files?api_key=${KEYS.full}`)
    assert.equal(status, 401)
    assert.equal(body.code, 'API_KEY_QUERY_NOT_ALLOWED')
  })

  test('a revoked key is rejected with 401', async () => {
    const { status, body } = await getJson('/api/v1/files', { headers: auth(KEYS.revoked) })
    assert.equal(status, 401)
    assert.equal(body.code, 'API_KEY_REVOKED')
  })

  test('a read-only key cannot write and is told which scope is missing', async () => {
    const { status, body } = await getJson('/api/v1/objects/proof.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.readOnly), 'Content-Type': 'text/plain' },
      body: 'nope',
    })
    assert.equal(status, 403)
    assert.equal(body.code, 'API_KEY_SCOPE_MISSING')
    assert.equal(body.requiredScope, 'files:write')
  })

  test('the scopes actually in force are returned on every authenticated response', async () => {
    const { status, headers } = await getJson('/api/v1/files', { headers: auth(KEYS.readOnly) })
    assert.equal(status, 200)
    assert.equal(headers.get('x-api-scopes'), 'files:read')
    assert.ok(headers.get('x-ratelimit-limit'), 'rate-limit budget is reported')
  })

  test('one tenant cannot see another tenant’s files', async () => {
    const created = await getJson('/api/v1/objects/tenant/secret.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: 'private to user 1',
    })
    assert.equal(created.status, 201)

    const mine = await getJson('/api/v1/objects?prefix=tenant/', { headers: auth(KEYS.full) })
    assert.equal(mine.body.objects.length, 1)

    const theirs = await getJson('/api/v1/objects?prefix=tenant/', { headers: auth(KEYS.otherUser) })
    assert.equal(theirs.status, 200)
    assert.equal(theirs.body.objects.length, 0, 'tenant 2 must not see tenant 1 objects')
  })
})

describe('object API: upload, verify, read, list, delete', () => {
  test('PUT writes real bytes and reports the identifier, provider metadata and ETag', async () => {
    const { status, body } = await getJson('/api/v1/objects/notes/hello.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: SMALL_BODY,
    })
    assert.equal(status, 201)
    assert.equal(body.key, 'notes/hello.txt')
    assert.equal(body.sizeBytes, String(SMALL_BODY.length))
    assert.equal(body.checksum, SMALL_MD5)
    assert.equal(body.etag, `"${SMALL_MD5}"`)
    assert.equal(body.created, true)
    assert.equal(body.mimeType, 'text/plain')

    // The row is only `active` because the provider was asked to confirm it.
    const stored = prisma._store.file.find((row) => row.objectKey === 'notes/hello.txt')
    assert.equal(stored.status, 'active')
    assert.equal(stored.provider, 's3')
    assert.ok(stored.providerFileId.startsWith('9drive/user-1/'), 'the S3 key is namespaced per user')
    // And the bytes really landed at the provider.
    assert.equal(s3.objects.get(`edvanta-bucket/${stored.providerFileId}`).body.toString(), SMALL_BODY)
  })

  test('GET returns the exact bytes with cache validators', async () => {
    const response = await fetch(url('/api/v1/objects/notes/hello.txt'), { headers: auth(KEYS.full) })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), SMALL_BODY)
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(response.headers.get('etag'), `"${SMALL_MD5}"`)
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
  })

  test('HEAD returns metadata and no body', async () => {
    const response = await fetch(url('/api/v1/objects/notes/hello.txt'), { method: 'HEAD', headers: auth(KEYS.full) })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), String(SMALL_BODY.length))
    assert.equal(response.headers.get('etag'), `"${SMALL_MD5}"`)
    assert.equal(await response.text(), '')
  })

  test('a conditional GET revalidates with 304', async () => {
    const response = await fetch(url('/api/v1/objects/notes/hello.txt'), {
      headers: { ...auth(KEYS.full), 'If-None-Match': `"${SMALL_MD5}"` },
    })
    assert.equal(response.status, 304)
  })

  test('a Range request returns 206 with the requested slice', async () => {
    const response = await fetch(url('/api/v1/objects/notes/hello.txt'), {
      headers: { ...auth(KEYS.full), Range: 'bytes=0-4' },
    })
    assert.equal(response.status, 206)
    assert.equal(await response.text(), 'hello')
    assert.match(response.headers.get('content-range'), /^bytes 0-4\/13$/)
  })

  test('PUT to the same key overwrites in place and stays one row', async () => {
    const updated = 'hello edvanta, again'
    const { status, body } = await getJson('/api/v1/objects/notes/hello.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: updated,
    })
    assert.equal(status, 200)
    assert.equal(body.created, false)
    assert.equal(body.sizeBytes, String(updated.length))

    const response = await fetch(url('/api/v1/objects/notes/hello.txt'), { headers: auth(KEYS.full) })
    assert.equal(await response.text(), updated)

    const rows = prisma._store.file.filter((row) => row.objectKey === 'notes/hello.txt')
    assert.equal(rows.length, 1, 'an overwrite must not create a second row')
  })

  test('GET /api/v1/objects lists by prefix with S3-shaped entries', async () => {
    const { status, body } = await getJson('/api/v1/objects?prefix=notes/', { headers: auth(KEYS.full) })
    assert.equal(status, 200)
    assert.equal(body.objects.length, 1)
    const [entry] = body.objects
    assert.equal(entry.key, 'notes/hello.txt')
    assert.equal(entry.sizeBytes, '20')
    assert.equal(entry.mimeType, 'text/plain')
    assert.equal(typeof entry.checksum, 'string')
    assert.equal(entry.etag, `"${entry.checksum}"`)
    assert.equal(body.isTruncated, false)
  })

  test('a signed URL lets a browser read the object without holding the API key', async () => {
    const { status, body } = await getJson('/api/v1/objects/sign', {
      method: 'POST',
      headers: { ...auth(KEYS.full), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'notes/hello.txt', method: 'GET', expiresInSeconds: 300 }),
    })
    assert.equal(status, 201)
    assert.match(body.url, /\/api\/public\/objects\/notes\/hello\.txt\?/)
    assert.ok(body.url.includes('sig='), 'the link carries its own signature')

    // Deliberately no Authorization header: the signature is the credential.
    const anonymous = await fetch(body.url)
    assert.equal(anonymous.status, 200)
    assert.equal(await anonymous.text(), 'hello edvanta, again')

    // A tampered signature is refused even for a valid, unexpired link.
    const tampered = await fetch(`${body.url.slice(0, -3)}abc`)
    assert.equal(tampered.status, 403)
    assert.equal((await tampered.json()).code, 'SIGNED_URL_INVALID')
  })

  test('a read-only key cannot sign a PUT link', async () => {
    const { status, body } = await getJson('/api/v1/objects/sign', {
      method: 'POST',
      headers: { ...auth(KEYS.readOnly), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'notes/hello.txt', method: 'PUT' }),
    })
    assert.equal(status, 403)
    assert.equal(body.code, 'API_KEY_SCOPE_MISSING')
    assert.equal(body.requiredScope, 'files:write')
  })

  test('DELETE removes the bytes at the provider and is idempotent', async () => {
    const stored = prisma._store.file.find((row) => row.objectKey === 'notes/hello.txt')
    const providerKey = stored.providerFileId

    const first = await fetch(url('/api/v1/objects/notes/hello.txt'), { method: 'DELETE', headers: auth(KEYS.full) })
    assert.equal(first.status, 204)

    assert.equal(s3.objects.has(`edvanta-bucket/${providerKey}`), false, 'the provider object must be gone')

    const missing = await getJson('/api/v1/objects/notes/hello.txt', { headers: auth(KEYS.full) })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.code, 'NO_SUCH_KEY')

    const second = await fetch(url('/api/v1/objects/notes/hello.txt'), { method: 'DELETE', headers: auth(KEYS.full) })
    assert.equal(second.status, 204, 'DELETE is idempotent, as in S3')
  })

  test('a key without the delete scope cannot delete', async () => {
    await getJson('/api/v1/objects/keepme.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: 'keep me',
    })
    const { status, body } = await getJson('/api/v1/objects/keepme.txt', { method: 'DELETE', headers: auth(KEYS.readOnly) })
    assert.equal(status, 403)
    assert.equal(body.code, 'API_KEY_SCOPE_MISSING')
    assert.equal(body.requiredScope, 'files:delete')
  })
})

describe('request validation', () => {
  test('an upload with no declared size is refused with 411', async () => {
    const { status, body } = await getJson('/api/v1/objects/empty.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: '',
    })
    assert.equal(status, 411)
    assert.equal(body.code, 'OBJECT_SIZE_REQUIRED')
  })

  test('malformed object keys are refused with 400', async () => {
    const cases = [
      ['notes//dup.txt', /empty segment/],
      ['bad%00name.txt', /control characters/],
      ['prefix/', /must not end with/],
      ['x'.repeat(701), /limited to 700 characters/],
    ]
    for (const [key, expected] of cases) {
      const { status, body } = await getJson(`/api/v1/objects/${key}`, {
        method: 'PUT',
        headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
        body: 'nope',
      })
      assert.equal(status, 400, `${key} must be refused`)
      assert.equal(body.code, 'OBJECT_KEY_INVALID')
      assert.match(body.message, expected)
    }
  })

  test('a traversal key never reaches the object store', async () => {
    // `..` is normalised out of the path before the router sees it, so this is
    // defence in depth: refused, and nothing is written under another prefix.
    const { status } = await getJson('/api/v1/objects/%2e%2e/escape.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: 'nope',
    })
    assert.ok(status >= 400, 'a traversal attempt must be refused')
    assert.equal([...s3.objects.keys()].some((key) => key.includes('escape.txt')), false)
    assert.equal(prisma._store.file.some((row) => row.objectKey?.includes('escape.txt')), false)
  })

  test('an upload over the configured limit is refused with 413', async () => {
    const oversized = 'x'.repeat(Number(process.env.MAX_UPLOAD_BYTES) + 1024)
    const { status, body } = await getJson('/api/v1/objects/big.bin', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'application/octet-stream' },
      body: oversized,
    })
    assert.equal(status, 413)
    assert.equal(body.code, 'OBJECT_TOO_LARGE')
    assert.equal(prisma._store.file.some((row) => row.objectKey === 'big.bin' && row.status === 'active'), false)
  })
})

describe('file API: upload, metadata, download, delete', () => {
  let fileId

  test('POST /api/v1/files/raw uploads a file and returns its metadata', async () => {
    const { status, body } = await getJson('/api/v1/files/raw?name=syllabus.pdf&type=application/pdf', {
      method: 'POST',
      headers: { ...auth(KEYS.full), 'Content-Type': 'application/pdf' },
      body: '%PDF-1.4 e2e syllabus',
    })
    assert.equal(status, 201)
    fileId = body.file.id
    assert.equal(body.file.name, 'syllabus.pdf')
    assert.equal(body.file.mimeType, 'application/pdf')
    assert.equal(body.file.sizeBytes, '21')
    assert.equal(body.file.provider, 's3')
    assert.ok(body.file.urls.content.endsWith(`/api/v1/files/${fileId}/content`))
  })

  test('a multipart upload is accepted and routed the same way', async () => {
    const form = new FormData()
    // `sizeBytes` must precede the file part: the provider is chosen before the
    // bytes are read, so the size is required up front.
    form.append('sizeBytes', '12')
    form.append('fileName', 'multipart.txt')
    form.append('mimeType', 'text/plain')
    form.append('file', new Blob(['multipart ok'], { type: 'text/plain' }), 'multipart.txt')

    const { status, body } = await getJson('/api/v1/files', {
      method: 'POST',
      headers: auth(KEYS.full),
      body: form,
    })
    assert.equal(status, 201)
    // A single non-batch upload answers with `{ file }`, like every other
    // endpoint here; a batch answers with `{ files, failed }`.
    assert.equal(body.file.name, 'multipart.txt')
    assert.equal(body.file.sizeBytes, '12')
    assert.equal(body.file.provider, 's3')
  })

  test('GET /api/v1/files lists files and GET /api/v1/files/:id returns one', async () => {
    const list = await getJson('/api/v1/files?limit=10', { headers: auth(KEYS.full) })
    assert.equal(list.status, 200)
    assert.ok(list.body.files.some((file) => file.id === fileId))

    const one = await getJson(`/api/v1/files/${fileId}`, { headers: auth(KEYS.full) })
    assert.equal(one.status, 200)
    assert.equal(one.body.file.id, fileId)
    assert.equal(one.body.file.name, 'syllabus.pdf')
    assert.equal(one.body.share, null)
  })

  test('GET /api/v1/files/:id/content streams the bytes back', async () => {
    const response = await fetch(url(`/api/v1/files/${fileId}/content`), { headers: auth(KEYS.full) })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '%PDF-1.4 e2e syllabus')
  })

  test('DELETE trashes the file first and only deletes at the provider when asked', async () => {
    const trashed = await getJson(`/api/v1/files/${fileId}`, { method: 'DELETE', headers: auth(KEYS.full) })
    assert.equal(trashed.status, 200)
    assert.equal(trashed.body.permanent, false)

    const content = await getJson(`/api/v1/files/${fileId}/content`, { headers: auth(KEYS.full) })
    assert.equal(content.status, 410)
    assert.equal(content.body.code, 'FILE_TRASHED')

    const stored = prisma._store.file.find((row) => row.id === fileId)
    const providerKey = stored.providerFileId
    assert.equal(s3.objects.has(`edvanta-bucket/${providerKey}`), true, 'trashing must not delete the bytes')

    const permanent = await getJson(`/api/v1/files/${fileId}?permanent=1`, { method: 'DELETE', headers: auth(KEYS.full) })
    assert.equal(permanent.status, 200)
    assert.equal(permanent.body.permanent, true)
    assert.equal(s3.objects.has(`edvanta-bucket/${providerKey}`), false, 'a permanent delete removes the bytes')
  })
})

describe('storage usage reporting', () => {
  test('GET /api/v1/usage and /api/v1/me report real capacity across accounts', async () => {
    await settleBackgroundWork()

    const usage = await getJson('/api/v1/usage', { headers: auth(KEYS.full) })
    assert.equal(usage.status, 200)
    assert.equal(usage.body.accounts, 10)
    assert.equal(usage.body.storage.reported, true)
    // Nine 15 GiB Drive accounts plus a 1 GiB bucket.
    assert.equal(usage.body.totalBytes, String(9n * BigInt(15 * 1024 * 1024 * 1024) + BigInt(1024 * 1024 * 1024)))
    assert.ok(Number(usage.body.availableBytes) > 0)

    const me = await getJson('/api/v1/me', { headers: auth(KEYS.full) })
    assert.equal(me.status, 200)
    assert.equal(me.body.key.id, 'key-full')
    assert.deepEqual(me.body.key.scopes, ['files:read', 'files:write', 'files:delete'])
    assert.equal(me.body.storage.accounts.connected, 10)
    assert.equal(me.body.storage.accounts.googleDrive, 9)
    assert.equal(me.body.storage.accounts.s3, 1)
  })
})

describe('failed uploads are never reported as successful', () => {
  test('when the provider refuses the write, the API fails and stores no active row', async () => {
    s3.failures.put = true
    try {
      const { status, body } = await getJson('/api/v1/objects/never-lands.txt', {
        method: 'PUT',
        headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
        body: 'this must not be reported as stored',
      })
      assert.equal(status, 502, 'a provider failure must not look like a success')
      assert.equal(body.code, 'UPLOAD_FAILED')

      // The provisional row is removed rather than left active (or left in the
      // owner's trash), so the key stays usable for a later retry.
      const row = prisma._store.file.find((item) => item.objectKey === 'never-lands.txt')
      assert.ok(!row || row.status !== 'active', 'a failed upload must leave no active row')

      const readBack = await getJson('/api/v1/objects/never-lands.txt', { headers: auth(KEYS.full) })
      assert.equal(readBack.status, 404)

      const listed = await getJson('/api/v1/objects?prefix=never-lands', { headers: auth(KEYS.full) })
      assert.equal(listed.body.objects.length, 0)

      // The failure message is operator-safe: no bucket, endpoint or key id.
      const serialised = JSON.stringify(body)
      for (const leaked of ['edvanta-bucket', s3.url, 'AKIAE2ETESTKEY']) {
        assert.equal(serialised.includes(leaked), false, `the error must not leak ${leaked}`)
      }
    } finally {
      s3.failures.put = false
    }
  })

  test('a later retry with the same key succeeds once the provider recovers', async () => {
    const { status, body } = await getJson('/api/v1/objects/never-lands.txt', {
      method: 'PUT',
      headers: { ...auth(KEYS.full), 'Content-Type': 'text/plain' },
      body: 'retry stored this time',
    })
    assert.equal(status, 201, 'the key stays usable after a failed attempt')
    assert.equal(body.created, true)

    const response = await fetch(url('/api/v1/objects/never-lands.txt'), { headers: auth(KEYS.full) })
    assert.equal(await response.text(), 'retry stored this time')
  })
})
