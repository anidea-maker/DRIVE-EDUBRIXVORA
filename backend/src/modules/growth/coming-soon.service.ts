import { prisma } from '../../config/prisma.js'
import { DEFAULT_FEATURES, DEFAULT_SONGS } from './catalog.js'

/**
 * The Coming Soon catalogue.
 *
 * Seeded lazily on first read instead of by a deploy-time script. Two reasons:
 * a fresh self-hosted instance should show the page without running anything,
 * and an existing deployment should gain the new rows on upgrade without an
 * operator remembering to run a seed. Seeding is *additive* - a feature the
 * administrator deleted is not resurrected on the next request, because the seed
 * only runs while the table is empty.
 */

export const FEATURE_STATUSES = ['coming_soon', 'beta', 'live', 'paused'] as const

export type FeatureStatus = (typeof FEATURE_STATUSES)[number]

export async function ensureComingSoonSeeded() {
  const existing = await prisma.comingSoonFeature.count()
  if (existing > 0) return

  /**
   * Row by row, not `createMany`: SQLite does not support `skipDuplicates`, so a
   * batch insert would either fail wholesale on a concurrent seed or need a
   * dialect-specific branch. Individual creates tolerate the race - the loser of
   * a duplicate key simply moves on - and the catalogue is a handful of rows.
   */
  for (const feature of DEFAULT_FEATURES) {
    await prisma.comingSoonFeature
      .create({
        data: {
          key: feature.key,
          title: feature.title,
          summary: feature.summary,
          description: feature.description,
          category: feature.category,
          icon: feature.icon,
          status: feature.status,
          sortOrder: feature.sortOrder,
          targetRelease: feature.targetRelease,
        },
      })
      .catch((error) => {
        // P2002 = another request seeded the same key first. Both are correct.
        if (String(error?.code) !== 'P2002') throw error
      })
  }
}

/** Songs seed on the same terms; an emptied catalogue stays emptied. */
export async function ensureSongsSeeded() {
  const existing = await prisma.song.count()
  if (existing > 0) return

  // Same reasoning as the feature seed above: no `skipDuplicates` on SQLite.
  for (const song of DEFAULT_SONGS) {
    await prisma.song.create({
      data: {
        title: song.title,
        artist: song.artist,
        album: song.album,
        durationSeconds: song.durationSeconds,
        genre: song.genre,
        collection: song.collection,
        sortOrder: song.sortOrder,
        enabled: true,
      },
    })
  }
}

type FeatureRow = {
  id: string
  key: string
  title: string
  summary: string
  description: string | null
  category: string
  icon: string
  status: string
  sortOrder: number
  targetRelease: string | null
  createdAt: Date
  updatedAt: Date
  _count?: { votes: number }
}

/**
 * The wire shape of a feature.
 *
 * `voteCount` is always present so the UI has one number to render; `voted` is
 * null when the caller is anonymous, which lets the page skip the button rather
 * than guess.
 */
export function serializeFeature(feature: FeatureRow, options: { voted?: boolean | null } = {}) {
  return {
    id: feature.id,
    key: feature.key,
    title: feature.title,
    summary: feature.summary,
    description: feature.description,
    category: feature.category,
    icon: feature.icon,
    status: feature.status,
    sortOrder: feature.sortOrder,
    targetRelease: feature.targetRelease,
    voteCount: feature._count?.votes ?? 0,
    voted: options.voted ?? null,
    createdAt: feature.createdAt.toISOString(),
    updatedAt: feature.updatedAt.toISOString(),
  }
}

/** Features plus this caller's votes, ordered for display. */
export async function listFeatures(options: { userId?: string; includePaused?: boolean } = {}) {
  await ensureComingSoonSeeded()

  const features = await prisma.comingSoonFeature.findMany({
    where: options.includePaused ? {} : { status: { not: 'paused' } },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    include: { _count: { select: { votes: true } } },
  })

  let voted = new Set<string>()
  if (options.userId && features.length > 0) {
    const votes = await prisma.featureVote.findMany({
      where: { userId: options.userId, featureId: { in: features.map((feature) => feature.id) } },
      select: { featureId: true },
    })
    voted = new Set(votes.map((vote) => vote.featureId))
  }

  return features.map((feature) =>
    serializeFeature(feature, { voted: options.userId ? voted.has(feature.id) : null }),
  )
}

export type SongRow = {
  id: string
  title: string
  artist: string
  album: string | null
  durationSeconds: number
  genre: string
  artworkUrl: string | null
  collection: string
  enabled: boolean
  sortOrder: number
}

/**
 * A song, as the page shows it.
 *
 * `playable` is false for everything today, and it is in the payload on purpose:
 * the UI renders a disabled play button from a field the server owns rather than
 * from a hard-coded assumption in the component, so turning playback on later is
 * a server change with no frontend release.
 */
export function serializeSong(song: SongRow) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationSeconds: song.durationSeconds,
    durationLabel: formatDuration(song.durationSeconds),
    genre: song.genre,
    collection: song.collection,
    artworkUrl: song.artworkUrl,
    playable: false,
    note: 'Listing only - playback arrives with the Songs library.',
  }
}

/** `3:34` for a track, `-` when the length is unknown. */
export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const total = Math.trunc(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export async function listSongs(options: { collection?: string; genre?: string; q?: string; limit?: number } = {}) {
  await ensureSongsSeeded()

  const songs = await prisma.song.findMany({
    where: {
      enabled: true,
      ...(options.collection ? { collection: options.collection } : {}),
      ...(options.genre ? { genre: options.genre } : {}),
      ...(options.q ? { OR: [{ title: { contains: options.q } }, { artist: { contains: options.q } }, { album: { contains: options.q } }] } : {}),
    },
    orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
    take: Math.min(Math.max(options.limit ?? 100, 1), 200),
  })

  const collections = await prisma.song.findMany({
    where: { enabled: true },
    select: { collection: true },
    distinct: ['collection'],
    orderBy: { collection: 'asc' },
  })

  return {
    songs: songs.map(serializeSong),
    total: songs.length,
    collections: collections.map((row) => row.collection),
  }
}
