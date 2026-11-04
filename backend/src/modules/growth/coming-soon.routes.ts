import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { optionalAuth, requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { requireRole } from '../../middleware/role.middleware.js'
import { createAuditLog } from '../../utils/audit.js'
import { FEATURE_STATUSES, listFeatures, listSongs, serializeFeature } from './coming-soon.service.js'

/**
 * The Coming Soon page: what is not released yet, what is being built, and a way
 * to say "I want that".
 *
 * Reading is public so the page works before sign-in and can be linked from a
 * marketing site. Voting needs a session, because a vote is a signal about real
 * demand and anonymous buttons measure curiosity, not demand.
 */
export const comingSoonRouter = Router()

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
})

/**
 * Every feature, newest announcements last-but-one.
 *
 * `summary` groups them by category so the page can render sections without a
 * second round trip, and so a new category appears automatically.
 */
comingSoonRouter.get('/features', optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const query = listQuery.parse(req.query)
    const features = await listFeatures({ userId: req.user?.id })

    const needle = query.q?.toLowerCase()
    const filtered = features.filter((feature) => {
      if (query.category && feature.category.toLowerCase() !== query.category.toLowerCase()) return false
      if (!needle) return true
      return (
        feature.title.toLowerCase().includes(needle) ||
        feature.summary.toLowerCase().includes(needle) ||
        feature.category.toLowerCase().includes(needle)
      )
    })

    const categories = [...new Set(filtered.map((feature) => feature.category))].sort()
    return res.json({ features: filtered, categories, total: filtered.length })
  } catch (error) {
    return next(error)
  }
})

/** One feature by its stable key, so a link survives a title change. */
comingSoonRouter.get('/features/:key', optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const features = await listFeatures({ userId: req.user?.id, includePaused: true })
    const feature = features.find((candidate) => candidate.key === String(req.params.key) || candidate.id === String(req.params.key))
    if (!feature) {
      return res.status(404).json({ code: 'FEATURE_NOT_FOUND', message: `There is no announced feature at "${req.params.key}".` })
    }
    return res.json({ feature })
  } catch (error) {
    return next(error)
  }
})

/**
 * "Notify me" — idempotent by design.
 *
 * A second POST from the same account does not stack a second vote; it reports
 * the current count with `created: false`. That makes the button safe to retry,
 * which is what a double-tap on a slow connection actually does.
 */
comingSoonRouter.post('/features/:key/vote', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const features = await listFeatures({ userId: req.user!.id, includePaused: true })
    const feature = features.find((candidate) => candidate.key === String(req.params.key) || candidate.id === String(req.params.key))
    if (!feature) {
      return res.status(404).json({ code: 'FEATURE_NOT_FOUND', message: `There is no announced feature at "${req.params.key}".` })
    }

    const existing = await prisma.featureVote.findUnique({ where: { featureId_userId: { featureId: feature.id, userId: req.user!.id } } })
    if (!existing) {
      await prisma.featureVote.create({ data: { featureId: feature.id, userId: req.user!.id } }).catch((error) => {
        // A racing double-tap loses the unique index; that is still one vote.
        if (String(error?.code) !== 'P2002') throw error
      })
    }

    const voteCount = await prisma.featureVote.count({ where: { featureId: feature.id } })
    return res.status(existing ? 200 : 201).json({ key: feature.key, voteCount, voted: true, created: !existing })
  } catch (error) {
    return next(error)
  }
})

comingSoonRouter.delete('/features/:key/vote', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const feature = await prisma.comingSoonFeature.findFirst({
      where: { OR: [{ key: String(req.params.key) }, { id: String(req.params.key) }] },
      select: { id: true, key: true },
    })
    if (!feature) {
      return res.status(404).json({ code: 'FEATURE_NOT_FOUND', message: `There is no announced feature at "${req.params.key}".` })
    }
    await prisma.featureVote.deleteMany({ where: { featureId: feature.id, userId: req.user!.id } })
    const voteCount = await prisma.featureVote.count({ where: { featureId: feature.id } })
    return res.json({ key: feature.key, voteCount, voted: false })
  } catch (error) {
    return next(error)
  }
})

/* -------------------------------------------------------------------------- */
/*  Songs (listing only)                                                      */
/* -------------------------------------------------------------------------- */

const songQuery = z.object({
  q: z.string().trim().max(120).optional(),
  collection: z.string().trim().max(60).optional(),
  genre: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/**
 * The catalogue behind the "Songs library" card.
 *
 * Public and read-only: playback is the unreleased part, so there is deliberately
 * no stream endpoint. Each song reports `playable: false` and the UI renders the
 * button disabled, which is honest about where the feature stops.
 */
comingSoonRouter.get('/songs', async (req, res, next) => {
  try {
    const query = songQuery.parse(req.query)
    const result = await listSongs(query)
    return res.json(result)
  } catch (error) {
    return next(error)
  }
})

/* -------------------------------------------------------------------------- */
/*  Administration                                                            */
/* -------------------------------------------------------------------------- */

export const comingSoonAdminRouter = Router()
comingSoonAdminRouter.use(requireAuth)
comingSoonAdminRouter.use(requireRole('manage_resources'))

const featureWrite = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Use lower-case letters, digits and dashes.')
    .optional(),
  title: z.string().trim().min(2).max(120).optional(),
  summary: z.string().trim().min(2).max(240).optional(),
  description: z.string().trim().max(4000).nullish(),
  category: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().min(1).max(60).optional(),
  status: z.enum(FEATURE_STATUSES).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  targetRelease: z.string().trim().max(60).nullish(),
})

/** Admins see paused entries too, otherwise a hidden row cannot be edited back. */
comingSoonAdminRouter.get('/features', async (req: AuthRequest, res, next) => {
  try {
    const features = await listFeatures({ userId: req.user!.id, includePaused: true })
    return res.json({ features, total: features.length })
  } catch (error) {
    return next(error)
  }
})

comingSoonAdminRouter.post('/features', async (req: AuthRequest, res, next) => {
  try {
    const body = featureWrite.parse(req.body ?? {})
    if (!body.key || !body.title || !body.summary) {
      return res.status(400).json({
        code: 'FEATURE_INCOMPLETE',
        message: 'A new feature needs a key, a title and a summary.',
      })
    }
    const clash = await prisma.comingSoonFeature.findUnique({ where: { key: body.key } })
    if (clash) {
      return res.status(409).json({ code: 'FEATURE_KEY_TAKEN', message: `"${body.key}" already exists. Pick another key.` })
    }

    const feature = await prisma.comingSoonFeature.create({
      data: {
        key: body.key,
        title: body.title,
        summary: body.summary,
        description: body.description ?? null,
        category: body.category ?? 'General',
        icon: body.icon ?? 'Sparkles',
        status: body.status ?? 'coming_soon',
        sortOrder: body.sortOrder ?? 100,
        targetRelease: body.targetRelease ?? null,
      },
      include: { _count: { select: { votes: true } } },
    })
    await createAuditLog(req.user!.id, 'CREATE_FEATURE', 'coming_soon_feature', feature.id, { key: feature.key })
    return res.status(201).json({ feature: serializeFeature(feature) })
  } catch (error) {
    return next(error)
  }
})

comingSoonAdminRouter.patch('/features/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = featureWrite.parse(req.body ?? {})
    const existing = await prisma.comingSoonFeature.findFirst({
      where: { OR: [{ id: String(req.params.id) }, { key: String(req.params.id) }] },
    })
    if (!existing) {
      return res.status(404).json({ code: 'FEATURE_NOT_FOUND', message: 'That feature does not exist.' })
    }
    if (body.key && body.key !== existing.key) {
      const clash = await prisma.comingSoonFeature.findUnique({ where: { key: body.key } })
      if (clash) return res.status(409).json({ code: 'FEATURE_KEY_TAKEN', message: `"${body.key}" already exists.` })
    }

    const feature = await prisma.comingSoonFeature.update({
      where: { id: existing.id },
      data: {
        ...(body.key === undefined ? {} : { key: body.key }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.summary === undefined ? {} : { summary: body.summary }),
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.category === undefined ? {} : { category: body.category }),
        ...(body.icon === undefined ? {} : { icon: body.icon }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
        ...(body.targetRelease === undefined ? {} : { targetRelease: body.targetRelease }),
      },
      include: { _count: { select: { votes: true } } },
    })
    await createAuditLog(req.user!.id, 'UPDATE_FEATURE', 'coming_soon_feature', feature.id, { key: feature.key, status: feature.status })
    return res.json({ feature: serializeFeature(feature) })
  } catch (error) {
    return next(error)
  }
})

comingSoonAdminRouter.delete('/features/:id', async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.comingSoonFeature.findFirst({
      where: { OR: [{ id: String(req.params.id) }, { key: String(req.params.id) }] },
      select: { id: true, key: true },
    })
    if (!existing) {
      return res.status(404).json({ code: 'FEATURE_NOT_FOUND', message: 'That feature does not exist.' })
    }
    // Votes cascade with the row, so nothing is left pointing at a deleted card.
    await prisma.comingSoonFeature.delete({ where: { id: existing.id } })
    await createAuditLog(req.user!.id, 'DELETE_FEATURE', 'coming_soon_feature', existing.id, { key: existing.key })
    return res.json({ status: 'ok', deleted: existing.key })
  } catch (error) {
    return next(error)
  }
})

/* ----------------------------------- songs --------------------------------- */

const songWrite = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  artist: z.string().trim().min(1).max(160).optional(),
  album: z.string().trim().max(160).nullish(),
  durationSeconds: z.number().int().min(0).max(86_400).optional(),
  genre: z.string().trim().min(1).max(40).optional(),
  artworkUrl: z.string().trim().url().max(500).nullish(),
  collection: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

comingSoonAdminRouter.get('/songs', async (req: AuthRequest, res, next) => {
  try {
    const songs = await prisma.song.findMany({ orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }], take: 500 })
    return res.json({ songs, total: songs.length })
  } catch (error) {
    return next(error)
  }
})

comingSoonAdminRouter.post('/songs', async (req: AuthRequest, res, next) => {
  try {
    const body = songWrite.parse(req.body ?? {})
    if (!body.title || !body.artist) {
      return res.status(400).json({ code: 'SONG_INCOMPLETE', message: 'A song needs a title and an artist.' })
    }
    const song = await prisma.song.create({
      data: {
        title: body.title,
        artist: body.artist,
        album: body.album ?? null,
        durationSeconds: body.durationSeconds ?? 0,
        genre: body.genre ?? 'study',
        artworkUrl: body.artworkUrl ?? null,
        collection: body.collection ?? 'Featured',
        enabled: body.enabled ?? true,
        sortOrder: body.sortOrder ?? 100,
      },
    })
    await createAuditLog(req.user!.id, 'CREATE_SONG', 'song', song.id, { title: song.title, artist: song.artist })
    return res.status(201).json({ song })
  } catch (error) {
    return next(error)
  }
})

comingSoonAdminRouter.patch('/songs/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = songWrite.parse(req.body ?? {})
    const existing = await prisma.song.findUnique({ where: { id: String(req.params.id) } })
    if (!existing) return res.status(404).json({ code: 'SONG_NOT_FOUND', message: 'That song does not exist.' })

    const song = await prisma.song.update({
      where: { id: existing.id },
      data: {
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.artist === undefined ? {} : { artist: body.artist }),
        ...(body.album === undefined ? {} : { album: body.album }),
        ...(body.durationSeconds === undefined ? {} : { durationSeconds: body.durationSeconds }),
        ...(body.genre === undefined ? {} : { genre: body.genre }),
        ...(body.artworkUrl === undefined ? {} : { artworkUrl: body.artworkUrl }),
        ...(body.collection === undefined ? {} : { collection: body.collection }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.sortOrder === undefined ? {} : { sortOrder: body.sortOrder }),
      },
    })
    await createAuditLog(req.user!.id, 'UPDATE_SONG', 'song', song.id, { title: song.title })
    return res.json({ song })
  } catch (error) {
    return next(error)
  }
})

comingSoonAdminRouter.delete('/songs/:id', async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.song.findUnique({ where: { id: String(req.params.id) }, select: { id: true, title: true } })
    if (!existing) return res.status(404).json({ code: 'SONG_NOT_FOUND', message: 'That song does not exist.' })
    await prisma.song.delete({ where: { id: existing.id } })
    await createAuditLog(req.user!.id, 'DELETE_SONG', 'song', existing.id, { title: existing.title })
    return res.json({ status: 'ok', deleted: existing.id })
  } catch (error) {
    return next(error)
  }
})
