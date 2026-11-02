/**
 * Mocked storage-status tests. No MySQL, Google Drive, S3 or HTTP server is
 * contacted; the Prisma client is stubbed with plain objects.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

process.env.DATABASE_URL ||= 'mysql://test:test@127.0.0.1:3306/testdb'
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY ||= 'y'.repeat(40)
process.env.NODE_ENV = 'test'

const require = createRequire(import.meta.url)
const status = require('../dist/modules/storage/storage-status.js')

test('storage status is always reported, even when capacity is unknown', () => {
  const report = status.buildStorageReport()
  assert.equal(report.status, 'connected')
  assert.equal(report.provider, '9drive')
  assert.equal(report.configured, '9drive')
  assert.equal(report.reported, true)
  assert.equal(report.persistence, 'Persistent')
  assert.equal(report.capacity.reported, false)
  assert.equal(report.capacity.totalBytes, null)
  assert.equal(report.capacity.availableBytes, null)
  assert.equal(report.capacity.fileCapRemaining, null)
  assert.equal(report.display.fileCapRemaining, 'Capacity not reported')
  assert.equal(report.display.storageProvider, '9drive')
  assert.equal(report.display.uploadEndpoint, '/api/v1/resources')
  assert.equal(report.display.uploadAvailable, false, 'no connected account was supplied')
  assert.equal(report.upload.available, false)
  assert.equal(report.upload.endpoint, '/api/v1/resources')
  assert.equal(report.upload.alternativeEndpoint, '/api/v1/files')
  assert.equal(report.upload.method, 'POST')
  assert.equal(report.upload.requiredScope, 'files:write')
  assert.match(report.upload.reason, /No connected storage account/)
  assert.match(report.display.storageProviderNote, /only destination/)
  assert.match(report.display.appRecords, /MySQL/)
  assert.match(report.note, /configured/)

  const wrapped = status.storageStatusResponse(report)
  assert.equal(wrapped.storage, report)
  assert.equal(wrapped.storageStatus, 'connected')
  assert.equal(wrapped.storageReported, true)
  assert.equal(wrapped.reported, true)
})

test('reported capacity produces real available bytes, not a fake zero', () => {
  const report = status.buildStorageReport({
    connectedAccounts: 2,
    googleDriveAccounts: 1,
    s3Accounts: 1,
    usedBytes: 100n,
    totalBytes: 1000n,
    capacityReported: true,
  })
  assert.equal(report.capacity.reported, true)
  assert.equal(report.capacity.usedBytes, '100')
  assert.equal(report.capacity.totalBytes, '1000')
  assert.equal(report.capacity.availableBytes, '900')
  assert.equal(report.capacity.fileCapRemaining, '900')
  assert.equal(report.display.fileCapRemaining, '900 bytes')
  assert.deepEqual(report.accounts, { connected: 2, googleDrive: 1, s3: 1 })
  assert.equal(report.upload.available, true)
  assert.equal(report.upload.reason, null)
  assert.equal(report.display.uploadAvailable, true)
})

test('degraded and unavailable states still keep reported true', () => {
  const degraded = status.buildStorageReport({ degraded: true, note: 'One provider failed.' })
  assert.equal(degraded.status, 'degraded')
  assert.equal(degraded.reported, true)
  assert.equal(degraded.note, 'One provider failed.')

  const unavailable = status.buildStorageReport({ unavailable: true })
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.reported, true)
  assert.equal(status.storageStatusResponse(unavailable).reported, true)
  assert.equal(unavailable.upload.available, false)
  assert.match(unavailable.upload.reason, /registry could not be read/)
})

test('readStorageReport aggregates accounts and falls back safely on DB errors', async () => {
  const fakePrisma = {
    connectedAccount: {
      findMany: async () => [
        { provider: 'google_drive', storageAccount: { totalBytes: 500n, usedBytes: 100n } },
        { provider: 's3', storageAccount: { totalBytes: null, usedBytes: 50n } },
      ],
    },
  }
  const report = await status.readStorageReport(fakePrisma)
  assert.equal(report.status, 'connected')
  assert.equal(report.accounts.connected, 2)
  assert.equal(report.accounts.googleDrive, 1)
  assert.equal(report.accounts.s3, 1)
  assert.equal(report.capacity.usedBytes, '150')
  assert.equal(report.capacity.reported, false, 'one account has no quota')
  assert.equal(report.capacity.totalBytes, null)
  assert.equal(report.reported, true)

  const brokenPrisma = {
    connectedAccount: {
      findMany: async () => {
        throw new Error('database down')
      },
    },
  }
  const broken = await status.readStorageReport(brokenPrisma)
  assert.equal(broken.status, 'unavailable')
  assert.equal(broken.reported, true)
  assert.match(broken.note, /unavailable/)
})
