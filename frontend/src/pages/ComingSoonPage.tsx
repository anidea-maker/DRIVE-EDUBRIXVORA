import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Bell,
  BellOff,
  BookOpen,
  BrainCircuit,
  Check,
  Coins,
  Download,
  Loader2,
  Music,
  PauseCircle,
  Play,
  Rocket,
  Search,
  Smartphone,
  Sparkles,
  Star,
  Trophy,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/drive/PageHeader'
import { API_URL, apiFetch, formatDate } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { cn } from '@/lib/utils'

/**
 * Coming Soon: what is not released yet.
 *
 * The page is driven entirely by `GET /coming-soon/features`, so a feature is
 * added, retitled, reordered, paused or marked live from the admin API without a
 * frontend deploy. Nothing below hard-codes a list of features.
 *
 * Three kinds of content live here, and they are separated on purpose:
 *   1. announcements - the cards, read-only for everyone;
 *   2. the songs preview - a real catalogue with playback deliberately disabled;
 *   3. your HXP - only shown when signed in, because it is personal.
 */

type FeatureStatus = 'coming_soon' | 'beta' | 'live' | 'paused'

type Feature = {
  id: string
  key: string
  title: string
  summary: string
  description: string | null
  category: string
  icon: string
  status: FeatureStatus
  sortOrder: number
  targetRelease: string | null
  voteCount: number
  voted: boolean | null
}

type Song = {
  id: string
  title: string
  artist: string
  album: string | null
  durationLabel: string
  genre: string
  collection: string
  artworkUrl: string | null
  playable: boolean
}

type PointsSummary = {
  balance: number
  currency: string
  activities: Array<{
    activity: string
    label: string
    points: number
    bonusPoints: number
    bonusThreshold: number
    earned: number
    awards: number
    enabled: boolean
  }>
  recent: Array<{ id: string; activity: string; points: number; createdAt: string; note: string | null }>
}

/**
 * lucide icon by name.
 *
 * The catalogue stores a name, so a new feature gets a sensible icon without a
 * component change. An unknown name falls back to a spark rather than crashing
 * the page over a cosmetic detail.
 */
const ICONS: Record<string, typeof Sparkles> = {
  Sparkles,
  Music,
  Trophy,
  BarChart3,
  BrainCircuit,
  Users,
  Download,
  Smartphone,
  BookOpen,
  Coins,
  Rocket,
  Star,
}

function FeatureIcon({ name }: { name: string }) {
  const Icon = ICONS[name] ?? Sparkles
  return <Icon className="h-5 w-5" />
}

const STATUS_STYLES: Record<FeatureStatus, { label: string; className: string }> = {
  coming_soon: { label: 'Coming soon', className: 'border-amber-200 bg-amber-50 text-amber-700' },
  beta: { label: 'In beta', className: 'border-sky-200 bg-sky-50 text-sky-700' },
  live: { label: 'Released', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  paused: { label: 'Paused', className: 'border-slate-200 bg-slate-50 text-slate-600' },
}

function StatusChip({ status }: { status: FeatureStatus }) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.coming_soon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold', style.className)}>
      {status === 'paused' ? <PauseCircle className="h-3 w-3" /> : null}
      {status === 'live' ? <Check className="h-3 w-3" /> : null}
      {style.label}
    </span>
  )
}

/** A stable colour per artist, so a cover looks deliberate without artwork. */
function coverGradient(title: string) {
  const palette = [
    'from-blue-500 to-indigo-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-fuchsia-500 to-purple-600',
    'from-rose-500 to-pink-600',
    'from-cyan-500 to-sky-600',
  ]
  let hash = 0
  for (let index = 0; index < title.length; index += 1) hash = (hash * 31 + title.charCodeAt(index)) % 997
  return palette[hash % palette.length]
}

function useFeatures() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiFetch<{ features: Feature[] }>('/coming-soon/features')
      .then((data) => {
        if (!cancelled) setFeatures(data.features)
      })
      .catch((problem) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : 'Could not load the roadmap.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { features, setFeatures, loading, error }
}

function useSongs() {
  const [songs, setSongs] = useState<Song[]>([])
  const [collections, setCollections] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    apiFetch<{ songs: Song[]; collections: string[] }>('/coming-soon/songs')
      .then((data) => {
        if (cancelled) return
        setSongs(data.songs)
        setCollections(data.collections)
      })
      .catch(() => {
        // The catalogue is a preview; its absence must not break the roadmap.
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { songs, collections, loading }
}

export function ComingSoonPage() {
  const { features, setFeatures, loading, error } = useFeatures()
  const { songs, collections, loading: songsLoading } = useSongs()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [collection, setCollection] = useState<string>('All')
  const [voting, setVoting] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const signedIn = Boolean(getAccessToken())

  const categories = useMemo(() => ['All', ...new Set(features.map((feature) => feature.category))], [features])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return features.filter((feature) => {
      if (category !== 'All' && feature.category !== category) return false
      if (!needle) return true
      return (
        feature.title.toLowerCase().includes(needle) ||
        feature.summary.toLowerCase().includes(needle) ||
        (feature.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [features, query, category])

  const visibleSongs = useMemo(
    () => (collection === 'All' ? songs : songs.filter((song) => song.collection === collection)),
    [songs, collection],
  )

  /**
   * Votes are optimistic, then corrected by the server's count.
   *
   * A "notify me" button that waits for a round trip feels broken on a slow
   * connection, and the cost of being wrong is one flipped icon - the server
   * count wins either way. The call is idempotent, so a retry cannot double it.
   */
  async function toggleVote(feature: Feature) {
    if (!signedIn) {
      setMessage('Sign in to vote for a feature - votes are tied to an account so they mean something.')
      return
    }
    setVoting(feature.key)
    const nextVoted = !feature.voted
    setFeatures((current) =>
      current.map((entry) =>
        entry.key === feature.key
          ? { ...entry, voted: nextVoted, voteCount: Math.max(0, entry.voteCount + (nextVoted ? 1 : -1)) }
          : entry,
      ),
    )
    try {
      const result = nextVoted
        ? await apiFetch<{ voteCount: number; voted: boolean }>(`/coming-soon/features/${feature.key}/vote`, { method: 'POST' })
        : await apiFetch<{ voteCount: number; voted: boolean }>(`/coming-soon/features/${feature.key}/vote`, { method: 'DELETE' })
      setFeatures((current) =>
        current.map((entry) => (entry.key === feature.key ? { ...entry, voted: result.voted, voteCount: result.voteCount } : entry)),
      )
    } catch (problem) {
      // Put the card back the way the server last described it.
      setFeatures((current) =>
        current.map((entry) =>
          entry.key === feature.key ? { ...entry, voted: feature.voted, voteCount: feature.voteCount } : entry,
        ),
      )
      setMessage(problem instanceof Error ? problem.message : 'Could not record that vote.')
    } finally {
      setVoting(null)
    }
  }

  return (
    <>
      <PageHeader
        title="Coming Soon"
        description="What is being built next. Vote for the ones you want first - the count is what we look at."
        actions={
          <div className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-inset)] px-3 py-1.5 text-[12px] font-semibold text-slate-600">
            <Rocket className="h-3.5 w-3.5 text-[var(--accent)]" />
            {features.filter((feature) => feature.status === 'coming_soon').length} in the pipeline
          </div>
        }
      />

      {/* ------------------------------ your HXP ------------------------------ */}
      {signedIn ? <PointsCard /> : null}

      {message ? (
        <p className="mt-4 rounded-xl border border-[var(--accent-border)] bg-[var(--surface-inset)] p-3 text-[13px] font-semibold text-slate-700">
          {message}
        </p>
      ) : null}

      {/* ------------------------------ filters ------------------------------- */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search the roadmap"
            className="pl-9"
            aria-label="Search upcoming features"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setCategory(entry)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-[12px] font-bold transition',
                category === entry
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : 'border-[var(--border)] bg-[var(--surface)] text-slate-600 hover:border-[var(--accent-border)]',
              )}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      {/* ------------------------------ features ------------------------------ */}
      {loading ? (
        <div className="mt-10 flex items-center justify-center gap-2 text-[13px] font-semibold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the roadmap...
        </div>
      ) : error ? (
        <Card className="mt-6 p-5">
          <p className="text-[13px] font-semibold text-red-600">{error}</p>
        </Card>
      ) : visible.length === 0 ? (
        <Card className="mt-6 p-8 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-slate-300" />
          <p className="mt-2 text-[13px] font-semibold text-slate-600">Nothing matches that search yet.</p>
          <p className="text-[12px] text-slate-500">Try a different word, or clear the filters.</p>
        </Card>
      ) : (
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((feature) => (
            <Card key={feature.key} className="flex min-w-0 flex-col p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent-soft,var(--surface-inset))] text-[var(--accent)]">
                  <FeatureIcon name={feature.icon} />
                </div>
                <StatusChip status={feature.status} />
              </div>

              <h2 className="mt-3 text-[15px] font-extrabold leading-snug">{feature.title}</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{feature.summary}</p>

              {feature.description ? (
                <details className="group mt-2">
                  <summary className="cursor-pointer list-none text-[12px] font-bold text-[var(--accent)] marker:hidden">
                    What it will do
                  </summary>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-slate-500">{feature.description}</p>
                </details>
              ) : null}

              <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                <span className="text-[11px] font-semibold text-slate-400">
                  {feature.targetRelease ? `Targeting ${feature.targetRelease}` : feature.category}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant={feature.voted ? 'default' : 'outline'}
                  disabled={voting === feature.key}
                  onClick={() => toggleVote(feature)}
                  title={feature.voted ? 'You are on the list for this one' : 'Notify me when this ships'}
                  className="shrink-0"
                >
                  {voting === feature.key ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : feature.voted ? (
                    <Bell className="h-3.5 w-3.5" />
                  ) : (
                    <BellOff className="h-3.5 w-3.5" />
                  )}
                  <span className="ml-1.5 tabular">{feature.voteCount}</span>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ------------------------------- songs -------------------------------- */}
      <section className="mt-10">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-[17px] font-extrabold">
              <Music className="h-4 w-4 text-[var(--accent)]" /> Songs library
            </h2>
            <p className="mt-1 text-[13px] text-slate-500">
              A preview of the catalogue. Listing is live; playback ships with the library.
            </p>
          </div>
          {collections.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {['All', ...collections].map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => setCollection(entry)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[11.5px] font-bold transition',
                    collection === entry
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[var(--border)] bg-[var(--surface)] text-slate-600',
                  )}
                >
                  {entry}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {songsLoading ? (
          <div className="mt-4 flex items-center gap-2 text-[13px] font-semibold text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading songs...
          </div>
        ) : visibleSongs.length === 0 ? (
          <Card className="mt-4 p-6 text-center text-[13px] text-slate-500">No tracks in this collection yet.</Card>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleSongs.map((song) => (
              <Card key={song.id} className="flex min-w-0 items-center gap-3 p-3">
                <div
                  className={cn(
                    'flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br text-[13px] font-extrabold text-white',
                    coverGradient(song.title),
                  )}
                >
                  {song.artworkUrl ? (
                    <img src={song.artworkUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    song.title.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-extrabold">{song.title}</p>
                  <p className="truncate text-[12px] text-slate-500">
                    {song.artist}
                    {song.album ? ` - ${song.album}` : ''}
                  </p>
                </div>
                <span className="tabular shrink-0 text-[11.5px] font-semibold text-slate-400">{song.durationLabel}</span>
                {/*
                 * Disabled on purpose: the server reports `playable: false` and the
                 * catalogue has no stream endpoint, so the button reflects reality
                 * instead of pretending and then failing on click.
                 */}
                <button
                  type="button"
                  disabled
                  title="Playback ships with the Songs library"
                  aria-label={`${song.title} by ${song.artist} - playback not available yet`}
                  className="flex h-8 w-8 shrink-0 cursor-not-allowed items-center justify-center rounded-full border border-[var(--border)] text-slate-300"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
              </Card>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

/**
 * The signed-in HXP card.
 *
 * Readings come from `GET /points/me`, which returns the balance, the value of
 * each activity and the last twenty awards - the number is never shown without
 * the explanation that produced it.
 */
function PointsCard() {
  const [summary, setSummary] = useState<PointsSummary | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiFetch<PointsSummary>('/points/me')
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch((problem) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : 'Could not load your points.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return (
      <Card className="mt-5 p-4">
        <p className="text-[13px] font-semibold text-red-600">{error}</p>
      </Card>
    )
  }

  if (!summary) {
    return (
      <Card className="mt-5 flex items-center gap-2 p-4 text-[13px] font-semibold text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your HXP...
      </Card>
    )
  }

  return (
    <Card className="mt-5 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
            <Coins className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[13px] font-semibold text-slate-500">Your HXP</p>
            <p className="tabular text-[24px] font-extrabold leading-tight">{summary.balance}</p>
          </div>
        </div>
        <p className="max-w-md text-[12px] leading-relaxed text-slate-500">
          Points are earned when you read, take notes, finish a test or watch a video. An administrator sets what each
          activity is worth, and the totals refresh daily.
        </p>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {summary.activities.map((activity) => (
          <div key={activity.activity} className="rounded-xl border border-[var(--border)] bg-[var(--surface-inset)] p-3">
            <p className="text-[12px] font-bold text-slate-600">{activity.label}</p>
            <p className="tabular mt-0.5 text-[15px] font-extrabold">
              {activity.points}
              {activity.bonusPoints > 0 ? <span className="text-[11px] font-semibold text-slate-500"> +{activity.bonusPoints}</span> : null}
              <span className="ml-1 text-[11px] font-semibold text-slate-400">per {activity.activity}</span>
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              {activity.awards > 0 ? `${activity.earned} HXP earned` : 'Not earned yet'}
            </p>
          </div>
        ))}
      </div>

      {summary.recent.length > 0 ? (
        <div className="mt-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Recent</p>
          <ul className="mt-2 space-y-1.5">
            {summary.recent.slice(0, 5).map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 text-[12px] text-slate-600">
                <span className="truncate">
                  <span className="font-semibold capitalize">{entry.activity}</span>
                  {entry.note ? ` - ${entry.note}` : ''}
                </span>
                <span className="tabular shrink-0 font-bold text-emerald-600">+{entry.points}</span>
                <span className="shrink-0 text-slate-400">{formatDate(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  )
}

/**
 * Keeps `API_URL` referenced for the copy-paste snippets in the admin guide.
 * Exported so a future admin page can reuse the same base-resolution rules.
 */
export const comingSoonApiBase = `${API_URL}/coming-soon`
