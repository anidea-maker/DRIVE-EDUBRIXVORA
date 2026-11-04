/**
 * HXP points: the arithmetic and the wire contract.
 *
 * `computeAward` is pure, so the interesting rules - bonuses, caps, missing
 * scores - are tested without a database. The route-level behaviour (idempotency,
 * ownership, who may edit a rule) lives in `api-e2e.test.mjs`, where the real app
 * is running.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

process.env.DATABASE_URL ||= 'file:./test/.tmp/test.db'
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(40)
process.env.TOKEN_ENCRYPTION_KEY ||= 'y'.repeat(40)
process.env.NODE_ENV = 'test'

const require = createRequire(import.meta.url)
const points = require('../dist/modules/growth/points.service.js')
const catalog = require('../dist/modules/growth/catalog.js')
const comingSoon = require('../dist/modules/growth/coming-soon.service.js')

const rule = (overrides = {}) => ({ points: 10, bonusPoints: 0, bonusThreshold: 0, dailyCap: 0, ...overrides })

test('a plain activity pays exactly its rule value', () => {
  const award = points.computeAward({ ...rule(), alreadyToday: 0 })
  assert.equal(award.points, 10)
  assert.equal(award.rulePoints, 10)
  assert.equal(award.bonusPoints, 0)
  assert.equal(award.cappedBy, null)
})

test('a test score at or above the threshold pays the bonus', () => {
  const atThreshold = points.computeAward({ ...rule({ points: 25, bonusPoints: 15, bonusThreshold: 80 }), score: 80, alreadyToday: 0 })
  assert.equal(atThreshold.points, 40)
  assert.equal(atThreshold.bonusPoints, 15)

  const below = points.computeAward({ ...rule({ points: 25, bonusPoints: 15, bonusThreshold: 80 }), score: 79, alreadyToday: 0 })
  assert.equal(below.points, 25, 'one point short is still short')
  assert.equal(below.bonusPoints, 0)
})

test('a missing score never pays a bonus and never subtracts', () => {
  const award = points.computeAward({ ...rule({ points: 25, bonusPoints: 15, bonusThreshold: 80 }), score: null, alreadyToday: 0 })
  assert.equal(award.points, 25)
})

test('a bonus with no threshold can never pay, so it is ignored', () => {
  const award = points.computeAward({ ...rule({ points: 10, bonusPoints: 50, bonusThreshold: 0 }), score: 100, alreadyToday: 0 })
  assert.equal(award.points, 10, 'threshold 0 disables the bonus rather than paying it always')
})

test('the daily cap pays only what is left of the budget', () => {
  const partial = points.computeAward({ ...rule({ points: 25, dailyCap: 100 }), alreadyToday: 90 })
  assert.equal(partial.points, 10)
  assert.equal(partial.cappedBy, 'daily_cap')

  const spent = points.computeAward({ ...rule({ points: 25, dailyCap: 100 }), alreadyToday: 100 })
  assert.equal(spent.points, 0, 'a spent budget pays nothing, which the route turns into a 429')
})

test('a cap of 0 means uncapped', () => {
  const award = points.computeAward({ ...rule({ points: 500, dailyCap: 0 }), alreadyToday: 10_000 })
  assert.equal(award.points, 500)
  assert.equal(award.cappedBy, null)
})

test('a negative rule value is treated as zero, not as a deduction', () => {
  const award = points.computeAward({ ...rule({ points: -50 }), alreadyToday: 0 })
  assert.equal(award.points, 0)
})

test('the daily window starts at midnight UTC', () => {
  const start = points.startOfUtcDay(new Date('2026-03-04T23:59:59.999Z'))
  assert.equal(start.toISOString(), '2026-03-04T00:00:00.000Z')
})

test('every activity in the catalogue has a default rule and vice versa', () => {
  const activities = catalog.DEFAULT_POINTS_RULES.map((entry) => entry.activity).sort()
  assert.deepEqual(activities, [...catalog.HXP_ACTIVITIES].sort())
  for (const entry of catalog.DEFAULT_POINTS_RULES) {
    assert.ok(entry.points > 0, `${entry.activity} must be worth something by default`)
    assert.ok(entry.dailyCap >= 0)
  }
})

test('the seeded catalogue announces the features the page promises', () => {
  const keys = catalog.DEFAULT_FEATURES.map((feature) => feature.key)
  assert.ok(keys.includes('songs-library'), 'songs listing')
  assert.ok(keys.includes('hxp-points'), 'HXP points')
  // Keys are URL-safe and unique: they are the public identifier.
  assert.equal(new Set(keys).size, keys.length)
  for (const key of keys) assert.match(key, /^[a-z0-9-]+$/)
})

test('a song duration renders as mm:ss and never as a broken value', () => {
  assert.equal(comingSoon.formatDuration(214), '3:34')
  assert.equal(comingSoon.formatDuration(59), '0:59')
  assert.equal(comingSoon.formatDuration(3600), '60:00')
  assert.equal(comingSoon.formatDuration(0), '--:--')
  assert.equal(comingSoon.formatDuration(Number.NaN), '--:--')
})

test('a listed song says it is not playable, so the UI cannot promise streaming', () => {
  const song = comingSoon.serializeSong({
    id: 'song-1',
    title: 'Deep Focus',
    artist: 'Study Loop',
    album: 'Concentration',
    durationSeconds: 214,
    genre: 'focus',
    artworkUrl: null,
    collection: 'Focus',
    enabled: true,
    sortOrder: 10,
  })
  assert.equal(song.playable, false)
  assert.equal(song.durationLabel, '3:34')
  assert.match(song.note, /Listing only/)
})
