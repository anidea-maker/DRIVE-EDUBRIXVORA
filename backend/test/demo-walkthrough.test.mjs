/**
 * Runs the *published walkthrough* - `examples/other-website/demo.mjs` - against
 * the real Express app, over HTTP, with only the database and the S3-compatible
 * provider substituted.
 *
 * Why a separate test: `api-e2e.test.mjs` proves the routes behave, while this
 * proves the file a website actually copies works. A change to the wire shape,
 * a renamed field or a URL that forgets its signature fails here, in the exact
 * shape the integration guide documents.
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'

import { createFakePrisma } from './helpers/fake-prisma.mjs'
import { startFakeS3 } from './helpers/fake-s3.mjs'

const run = promisify(execFile)

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ||= 'file:./test/.tmp/test.db'
process.env.JWT_ACCESS_SECRET ||= 'j'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY ||= 'k'.repeat(40)
process.env.FRONTEND_URL = 'http://localhost:5173'
process.env.API_CORS_ORIGINS = ''
process.env.MAX_UPLOAD_BYTES = '65536'
process.env.API_RATE_LIMIT_PER_MINUTE = '600'
process.env.OBJECT_URL_SIGNING_SECRET = 'demo-walkthrough-secret-for-tests-only'

const require = createRequire(import.meta.url)
const prismaModulePath = require.resolve('../dist/config/prisma.js')
const prisma = createFakePrisma()

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

const API_KEY = '9d_live_demo_walkthrough_key'
const DEMO = fileURLToPath(new URL('../../examples/other-website/demo.mjs', import.meta.url))

let s3
let server
let base

before(async () => {
  s3 = await startFakeS3({ buckets: ['demo-bucket'] })

  const now = new Date()
  prisma._store.user.push({
    id: 'demo-user',
    name: 'Demo Owner',
    email: 'demo@example.com',
    passwordHash: 'not-a-real-hash',
    status: 'active',
    role: 'admin',
    createdAt: now,
    updatedAt: now,
  })

  prisma._store.connectedAccount.push({
    id: 'demo-account',
    userId: 'demo-user',
    provider: 's3',
    providerAccountId: 'demo-s3',
    email: 's3@example.com',
    displayName: 'Demo Bucket',
    status: 'connected',
    scopes: [],
    createdAt: now,
    updatedAt: now,
  })
  prisma._store.s3StorageConfig.push({
    id: 'demo-s3-config',
    userId: 'demo-user',
    connectedAccountId: 'demo-account',
    name: 'Demo Bucket',
    bucket: 'demo-bucket',
    region: 'us-east-1',
    endpoint: s3.url,
    accessKeyIdEncrypted: encryptText('AKIADEMOTESTKEY'),
    secretAccessKeyEncrypted: encryptText('demo-secret-access-key'),
    forcePathStyle: true,
    prefix: '9drive',
    quotaBytes: BigInt(1024 * 1024 * 1024),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  prisma._store.storageAccount.push({
    id: 'demo-storage',
    connectedAccountId: 'demo-account',
    totalBytes: BigInt(1024 * 1024 * 1024),
    usedBytes: 0n,
    availableBytes: BigInt(1024 * 1024 * 1024),
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  })
  // Pin uploads to the only reachable account, as an operator would in Settings.
  prisma._store.uploadRoutingPolicy.push({
    id: 'demo-policy',
    userId: 'demo-user',
    mode: 'priority',
    priorityAccountIds: ['demo-account'],
    roundRobinCursor: 0,
    createdAt: now,
    updatedAt: now,
  })
  prisma._store.apiKey.push({
    id: 'demo-key',
    userId: 'demo-user',
    name: 'Website',
    keyPrefix: '9d_live',
    keyHash: hashToken(API_KEY),
    scopes: ['files:read', 'files:write', 'files:delete'],
    status: 'active',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  })

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

test('the published walkthrough passes end to end, including cleanup', async () => {
  const { stdout } = await run(process.execPath, [DEMO], {
    env: {
      ...process.env,
      STORAGE_ENDPOINT: `${base}/api/v1`,
      STORAGE_API_KEY: API_KEY,
      STORAGE_PREFIX: 'demo-website',
    },
    timeout: 60_000,
  }).catch((error) => {
    // Surface the walkthrough's own report: it is far more specific than "exit 1".
    console.error('--- demo stdout ---\n' + (error.stdout ?? '') + '\n--- demo stderr ---\n' + (error.stderr ?? ''))
    throw error
  })

  // Every step the guide documents must have been exercised, not skipped.
  for (const step of [
    '1. upload',
    '2. list / show contents',
    '3. preview (no Authorization header)',
    '4. download',
    '5. the same thing through the file API',
    'cleanup',
  ]) {
    assert.ok(stdout.includes(step), `the walkthrough never reached "${step}"`)
  }
  const summary = stdout.match(/(\d+)\/(\d+) checks passed/)
  assert.ok(summary, `no summary line in the walkthrough output:\n${stdout}`)
  assert.equal(summary[1], summary[2], `the walkthrough reported failures:\n${stdout}`)
  // Guards against a step being silently skipped by a future edit.
  assert.ok(Number(summary[1]) >= 26, `only ${summary[1]} checks ran`)

  // Nothing was left behind in storage.
  assert.equal(prisma._store.file.filter((row) => row.objectKey?.startsWith('demo-website/') && row.status === 'active').length, 0)
})

test('a wrong key fails the walkthrough with the API’s own error', async () => {
  await assert.rejects(
    run(process.execPath, [DEMO], {
      env: { ...process.env, STORAGE_ENDPOINT: `${base}/api/v1`, STORAGE_API_KEY: '9d_live_not_a_real_key' },
      timeout: 60_000,
    }),
    (error) => {
      assert.match(String(error.stderr), /401 API_KEY_INVALID/)
      return true
    },
  )
})
