/**
 * Registry, security and URL-signing tests.
 *
 * IMPORTANT: these are MOCKED tests. No Google Drive, S3, database server or HTTP server
 * is contacted. Live cloud integration needs real credentials and the manual
 * checks in docs/EDVANTA-INTEGRATION.md; nothing here claims to verify those.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// config/env and @prisma/client are imported by some modules under test. These
// are dummy values used only to construct a client - no connection is made.
process.env.DATABASE_URL ||= 'file:./test/.tmp/test.db'
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY ||= 'y'.repeat(40)
process.env.SUPER_ADMIN_EMAILS = 'boss@example.com,second@example.com'
process.env.NODE_ENV = 'test'

const require = createRequire(import.meta.url)
const service = require('../dist/modules/resources/resource.service.js')
const signing = require('../dist/modules/public-api/object-signing.js')
const roles = require('../dist/modules/auth/roles.js')
const urls = require('../dist/modules/resources/resource-urls.js')
const s3 = require('../dist/modules/s3/s3.service.js')

function fakeRow(overrides = {}) {
  const now = new Date('2026-11-02T10:00:00.000Z')
  return {
    id: 'resource-1',
    userId: 'user-1',
    name: 'Biology - Cell Structure.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048n,
    provider: 's3',
    providerFileId: '9drive/user-1/file-1/biology.pdf',
    objectKey: 'edvanta/resources/request-12345678/biology.pdf',
    bucketName: 'edvanta-bucket',
    status: 'active',
    title: 'Cell Structure Notes',
    description: 'Chapter 3',
    category: 'Science',
    subject: 'Biology',
    academicLevel: 'Class 12',
    examType: 'CBSE',
    visibility: 'students',
    clientRequestId: 'request-12345678',
    resourceMetadata: { year: 2026 },
    uploadedBy: 'admin-1',
    lastModifiedBy: 'admin-1',
    availability: 'available',
    lastVerifiedAt: now,
    checksum: 'abc123',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    connectedAccountId: 'account-1',
    ...overrides,
  }
}

test('upload metadata validation: required title, bigint size, strict fields', () => {
  const parsed = service.resourceUploadSchema.parse({
    title: 'Motion Question Paper',
    subject: 'Physics',
    sizeBytes: '4096',
    visibility: 'students',
    provider: 's3',
  })
  assert.equal(parsed.sizeBytes, 4096n)
  assert.equal(parsed.visibility, 'students')
  assert.throws(() => service.resourceUploadSchema.parse({ sizeBytes: 10 }))
  assert.throws(() => service.resourceUploadSchema.parse({ title: 'x', sizeBytes: 10, role: 'super_admin' }))
  assert.throws(() => service.resourceUploadSchema.parse({ title: 'x', sizeBytes: 10, provider: 'dropbox' }))
  // A role must not be patchable from a browser request either.
  assert.throws(() => service.resourcePatchSchema.parse({ role: 'admin' }))
})

test('tolerant upload metadata accepts JSON wrappers, plain fields and 9Drive aliases', () => {
  const json = service.parseResourceUploadMeta({
    resourceMeta: JSON.stringify({
      title: 'Cell Structure',
      subject: 'Biology',
      sizeBytes: '2048',
      visibility: 'learner',
      provider: '9drive',
      clientRequestId: 'request-12345678',
      role: 'super_admin',
    }),
    fileName: 'biology.pdf',
    mimeType: 'application/pdf',
  })
  assert.equal(json.title, 'Cell Structure')
  assert.equal(json.subject, 'Biology')
  assert.equal(json.sizeBytes, 2048n)
  assert.equal(json.visibility, 'students')
  assert.equal(json.provider, undefined, '9drive means automatic 9Drive routing')
  assert.equal(json.clientRequestId, 'request-12345678')
  assert.equal(json.role, undefined, 'frontend-supplied roles are never accepted')

  const plain = service.parseResourceUploadMeta({
    title: 'Motion',
    size: '4096',
    name: 'motion.pdf',
    type: 'application/pdf',
    audience: 'everyone',
    storageProvider: 'auto',
    requestId: 'short',
    category: 'Physics',
  }, { filename: 'ignored.pdf', mimeType: 'text/plain' })
  assert.equal(plain.title, 'Motion')
  assert.equal(plain.sizeBytes, 4096n)
  assert.equal(plain.fileName, 'motion.pdf')
  assert.equal(plain.mimeType, 'application/pdf')
  assert.equal(plain.visibility, 'public')
  assert.equal(plain.provider, undefined)
  assert.equal(plain.clientRequestId, 'upload-short')

  const blob = service.parseResourceUploadMeta({
    title: 'Extra fields',
    sizeBytes: '10',
    metadata: JSON.stringify({ year: 2026, unit: 'Chapter 3' }),
  })
  assert.deepEqual(blob.metadata, { year: 2026, unit: 'Chapter 3' })
  assert.equal(blob.title, 'Extra fields')
  assert.throws(() => service.parseResourceUploadMeta({ resourceMeta: '{not-json', sizeBytes: '10' }))
  assert.throws(() => service.parseResourceUploadMeta({ title: 'No size' }))
})

test('B2 bucket names are normalized on read without touching other providers', () => {
  const b2 = { bucket: 'EDUBRIXVORA', endpoint: 'https://s3.us-east-005.backblazeb2.com' }
  assert.equal(s3.normalizeS3Config(b2).bucket, 'edubrixvora')
  assert.equal(b2.bucket, 'EDUBRIXVORA', 'the stored row is not rewritten')
  const aws = { bucket: 'MyBucket', endpoint: 'https://s3.amazonaws.com' }
  assert.equal(s3.normalizeS3Config(aws).bucket, 'MyBucket')
})

test('filename normalization removes path traversal and control characters', () => {
  assert.equal(service.safeResourceFileName('../../etc/passwd'), 'passwd')
  assert.equal(service.safeResourceFileName('C:\\notes\\chapter1.pdf'), 'chapter1.pdf')
  assert.equal(service.safeResourceFileName('a\u0000b"c.pdf'), 'ab-c.pdf')
  assert.equal(service.safeResourceFileName('..'), 'resource.bin')
})

test('retry-safe object key is stable, provider independent and path-safe', () => {
  const first = service.buildResourceObjectKey('upload-0001', '../../Biology Notes.pdf')
  const second = service.buildResourceObjectKey('upload-0001', '../../Biology Notes.pdf')
  assert.equal(first, second)
  assert.match(first, /^edvanta\/resources\/upload-0001\/Biology Notes\.pdf$/)
  assert.ok(!first.includes('..'))
  assert.notEqual(first, service.buildResourceObjectKey('upload-0002', 'Biology Notes.pdf'))
})

test('preview modes are honest about Office and unsupported formats', () => {
  assert.deepEqual(service.previewFor('application/pdf'), { supported: true, mode: 'pdf', reason: null })
  assert.equal(service.previewFor('image/png').mode, 'image')
  assert.equal(service.previewFor('text/plain').mode, 'text')
  assert.equal(service.previewFor('application/vnd.google-apps.document').mode, 'google-document')
  const office = service.previewFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(office.supported, false)
  assert.equal(office.mode, 'office')
  assert.match(office.reason, /conversion service/i)
  assert.equal(service.previewFor('image/svg+xml').supported, false)
  assert.equal(service.previewFor('application/x-rar-compressed').mode, 'unsupported')
})

test('keyset cursor round-trips and rejects tampering', () => {
  const cursor = { createdAt: '2026-11-02T10:00:00.000Z', id: 'resource-1', name: 'a.pdf', order: 'name' }
  const token = service.encodeResourceCursor(cursor)
  assert.deepEqual(service.decodeResourceCursor(token), cursor)
  assert.equal(service.decodeResourceCursor('not-base64-json'), null)
  assert.equal(service.decodeResourceCursor(Buffer.from('{"order":"name"}').toString('base64url')), null)
  assert.equal(service.decodeResourceCursor(undefined), null)
})

test('ZIP names preserve extensions and resolve collisions safely', () => {
  const names = service.resolveZipNames([
    { id: '1', name: '../notes.pdf' },
    { id: '2', name: 'notes.pdf' },
    { id: '3', name: 'NOTES.PDF' },
    { id: '4', name: 'diagram' },
  ])
  assert.deepEqual(names.map((entry) => entry.name), ['notes.pdf', 'notes (2).pdf', 'NOTES (3).PDF', 'diagram'])
  assert.ok(names.every((entry) => !entry.name.includes('/') && !entry.name.includes('..')))
})

test('bulk limits reject empty, too many and oversized selections', () => {
  const limits = { maxFiles: 3, maxBytes: 1000 }
  assert.equal(service.checkBulkLimits([], limits).code, 'BULK_EMPTY')
  assert.equal(service.checkBulkLimits([{ sizeBytes: 1n }, { sizeBytes: 1n }, { sizeBytes: 1n }, { sizeBytes: 1n }], limits).code, 'BULK_TOO_MANY_FILES')
  assert.equal(service.checkBulkLimits([{ sizeBytes: 600n }, { sizeBytes: 600n }], limits).code, 'BULK_TOO_LARGE')
  assert.equal(service.checkBulkLimits([{ sizeBytes: 600n }], limits).totalBytes, 600n)
})

test('serialized resource keeps a stable id and separates provider locators', () => {
  const s3 = service.serializeResource(fakeRow(), 'https://drive.example.com')
  assert.equal(s3.id, 'resource-1')
  assert.equal(s3.title, 'Cell Structure Notes')
  assert.equal(s3.fileSize, '2048')
  assert.equal(s3.storageProvider, 's3')
  assert.equal(s3.bucketName, 'edvanta-bucket')
  assert.equal(s3.googleDriveFileId, null)
  assert.equal(s3.previewSupported, true)
  assert.equal(s3.available, true)
  assert.match(s3.urls.preview, /^https:\/\/drive\.example\.com\/api\/v1\/resources\/resource-1\/preview$/)

  const drive = service.serializeResource(fakeRow({ provider: 'google_drive', providerFileId: 'drive-file-id', bucketName: null }), 'https://drive.example.com')
  assert.equal(drive.storageProvider, 'google_drive')
  assert.equal(drive.googleDriveFileId, 'drive-file-id')
  assert.equal(drive.bucketName, null)

  const missing = service.serializeResource(fakeRow({ availability: 'missing' }), 'https://drive.example.com')
  assert.equal(missing.available, false)
})

test('mocked upload: metadata is registered only after provider success, and retries do not duplicate', async () => {
  const uploads = []
  const updates = []
  const deps = {
    upload: async (input) => {
      uploads.push(input)
      return { ok: true, file: { id: 'file-1' } }
    },
    update: async (id, data) => {
      updates.push({ id, data })
      return fakeRow({ id, objectKey: uploads[uploads.length - 1].key })
    },
  }
  const meta = service.resourceUploadSchema.parse({ title: 'Cell Structure Notes', category: 'Science', sizeBytes: 2048, clientRequestId: 'request-12345678' })
  const input = { userId: 'user-1', meta, body: {}, fileName: 'biology.pdf', clientRequestId: 'request-12345678', now: new Date('2026-11-02T10:00:00.000Z') }

  const first = await service.createResourceRecord(deps, input)
  const second = await service.createResourceRecord(deps, input)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(uploads.length, 2)
  assert.equal(uploads[0].key, uploads[1].key, 'retry must PUT to the same object key')
  assert.equal(first.resource.id, second.resource.id, 'stable metadata row, not a duplicate')
  assert.equal(updates[0].data.isResource, true)
  assert.equal(updates[0].data.availability, 'available')
  assert.equal(updates[0].data.uploadedBy, 'user-1')
  assert.equal(updates[0].data.clientRequestId, 'request-12345678')
  assert.equal(updates[0].data.status, 'active')

  const failedDeps = {
    upload: async () => ({ ok: false, code: 'S3_ACCESS_DENIED', message: 'credentials rejected' }),
    update: async () => {
      throw new Error('update must not run after a failed upload')
    },
  }
  const failed = await service.createResourceRecord(failedDeps, input)
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'S3_ACCESS_DENIED')
})

test('mocked synchronization marks missing objects without overwriting metadata', async () => {
  const rows = [
    fakeRow({ id: 'r1' }),
    fakeRow({ id: 'r2', availability: 'unknown' }),
    fakeRow({ id: 'r3' }),
  ]
  const updates = []
  const result = await service.syncResourceBatch(
    {
      list: async () => rows,
      update: async (id, data) => updates.push({ id, data }),
      verify: async (row) => {
        if (row.id === 'r1') return { availability: 'available' }
        if (row.id === 'r2') return { availability: 'missing', detail: 'NoSuchKey' }
        return { availability: 'inaccessible', detail: 'AccessDenied' }
      },
      now: () => new Date('2026-11-02T11:00:00.000Z'),
    },
    { userId: 'user-1', cursor: null, limit: 4, order: 'newest' },
  )
  assert.equal(result.checked, 3)
  assert.equal(result.changed, 2)
  assert.equal(result.missing, 1)
  assert.equal(result.inaccessible, 1)
  assert.equal(result.problems.length, 2)
  assert.equal(result.nextCursor, null)
  assert.ok(updates.every((entry) => Object.keys(entry.data).sort().join(',') === 'availability,lastVerifiedAt'))
})

test('signed object URLs bind method, identity, key and expiry', () => {
  const key = 'edvanta/resources/request-12345678/biology.pdf'
  const keyId = 'api-key:key-1'
  const expiresAt = Math.floor(Date.now() / 1000) + 300
  const signature = signing.signObjectUrl('GET', 'user-1', keyId, key, expiresAt)
  const base = { method: 'GET', userId: 'user-1', keyId, key, expiresAt, signature }
  assert.equal(signing.verifyObjectUrl(base), null)
  assert.equal(signing.verifyObjectUrl({ ...base, method: 'HEAD' }), null)
  assert.equal(signing.verifyObjectUrl({ ...base, method: 'PUT' }), 'invalid')
  assert.equal(signing.verifyObjectUrl({ ...base, key: key + 'x' }), 'invalid')
  assert.equal(signing.verifyObjectUrl({ ...base, keyId: 'api-key:other' }), 'invalid')
  assert.equal(signing.verifyObjectUrl({ ...base, keyId: undefined }), 'identity')
  assert.equal(signing.verifyObjectUrl({ ...base, expiresAt: Math.floor(Date.now() / 1000) - 1 }), 'expired')
  assert.equal(signing.verifyObjectUrl({ ...base, signature: undefined }), 'missing')
  assert.equal(signing.signedObjectPath('a/b c.pdf', new URLSearchParams({ m: 'GET' })), '/api/public/objects/a/b%20c.pdf?m=GET')
})

test('capability URL minting never emits an API key and expires', async () => {
  const req = { protocol: 'https', get: (header) => (header === 'host' ? 'drive.example.com' : undefined) }
  const preview = await urls.mintResourceUrl(req, { id: 'f1', userId: 'u1', objectKey: 'edvanta/resources/request-12345678/a.pdf' }, { ttlSeconds: 300 })
  const download = await urls.mintResourceUrl(req, { id: 'f1', userId: 'u1', objectKey: 'edvanta/resources/request-12345678/a.pdf' }, { download: true, ttlSeconds: 300 })
  const url = new URL(download.url)
  assert.equal(url.origin, 'https://drive.example.com')
  assert.equal(url.searchParams.get('m'), 'GET')
  assert.equal(url.searchParams.get('download'), '1')
  assert.ok(url.searchParams.get('sig'))
  assert.ok(url.searchParams.get('exp'))
  assert.match(url.searchParams.get('k') ?? '', /^resource:f1$/)
  assert.equal(url.searchParams.get('api_key'), null)
  assert.equal(preview.mechanism, 'signed-object-url')
  assert.ok(new Date(download.expiresAt).getTime() > Date.now())
  assert.ok(!download.url.includes('u1@'))
})

test('fast live counts use a safe student filter and never invent categories', () => {
  const student = service.resourceCountsWhere('student', false)
  assert.deepEqual(student.visibility, { in: ['students', 'public'] })
  assert.equal(student.availability, 'available')
  assert.equal(student.isResource, true)
  assert.equal(student.status, 'active')
  const studentWithUnavailable = service.resourceCountsWhere('student', true)
  assert.equal(studentWithUnavailable.availability, undefined)
  const admin = service.resourceCountsWhere('admin', false)
  assert.equal(admin.visibility, undefined)
  assert.equal(admin.availability, undefined)

  assert.equal(service.resourceCountsCacheKey('u1', 'student', false), 'u1|student|0')
  assert.notEqual(service.resourceCountsCacheKey('u1', 'student', false), service.resourceCountsCacheKey('u1', 'admin', false))
  assert.deepEqual(service.emptyResourceCounts().byCategory, {})
  assert.deepEqual(
    service.normalizeCountGroups(
      [
        { category: 'Science', _count: { _all: 2 } },
        { category: null, _count: { _all: 3 } },
        { category: 'Science', _count: { _all: 1n } },
      ],
      'category',
    ),
    { Science: 3, Uncategorised: 3 },
  )
})

test('storage status is always reported, even when a provider is degraded', () => {
  const healthy = service.buildStorageStatus({
    databaseOk: true,
    accounts: [{ ok: true, provider: 's3' }, { ok: true, provider: 'google_drive' }],
    resources: { available: 10, missing: 0, inaccessible: 0, unknown: 0 },
    checkedAt: '2026-11-02T12:00:00.000Z',
  })
  assert.equal(healthy.status, 'connected')
  assert.equal(healthy.provider, '9Drive')
  assert.equal(healthy.reported, true)
  assert.deepEqual(healthy.database, { ok: true })

  const degraded = service.buildStorageStatus({
    databaseOk: true,
    accounts: [{ ok: true, provider: 's3' }, { ok: false, provider: 'google_drive', detail: 'auth expired' }],
    resources: { available: 9, missing: 1, inaccessible: 0, unknown: 0 },
    checkedAt: '2026-11-02T12:00:01.000Z',
  })
  assert.equal(degraded.status, 'degraded')
  assert.equal(degraded.reported, true)
})

test('roles come from server-side configuration, never a request body', () => {
  assert.equal(roles.DEFAULT_USER_ROLE, 'visitor', 'new accounts are least-privileged')
  assert.equal(roles.effectiveRole({ email: 'BOSS@example.com', role: 'student' }), 'super_admin')
  assert.equal(roles.effectiveRole({ email: 'admin@example.com', role: 'admin' }), 'admin')
  assert.equal(roles.effectiveRole({ email: 'student@example.com', role: 'student' }), 'student')
  assert.equal(roles.effectiveRole({ email: 'x@example.com', role: 'not-a-role' }), 'visitor')
  assert.equal(roles.canManageResources('admin'), true)
  assert.equal(roles.canManageResources('student'), false)
  assert.equal(roles.canManageAdministrators('admin'), false)
  assert.equal(roles.canManageAdministrators('super_admin'), true)
  assert.equal(roles.isActive({ status: 'disabled' }), false)
})
