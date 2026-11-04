/**
 * The HXP activity vocabulary and the seeded catalogue.
 *
 * Both live in one place for a reason: the activity names are written into the
 * ledger and read back by the balance query, so they are an enum in all but
 * declaration. If a name were spelled differently in a route and in a seed, the
 * points would still be awarded but silently never counted.
 */

/** Every activity the platform can pay for. Ordered as the UI shows them. */
export const HXP_ACTIVITIES = ['reading', 'notes', 'test', 'video'] as const
export type HxpActivity = (typeof HXP_ACTIVITIES)[number]

export function isHxpActivity(value: string): value is HxpActivity {
  return (HXP_ACTIVITIES as readonly string[]).includes(value)
}

/**
 * Default rules. `points` is what one verified activity is worth, `bonusPoints`
 * is added when the submission reports a score at or above `bonusThreshold`
 * (which only `test` and `video` normally set), and `dailyCap` stops one
 * enthusiastic learner from farming a single activity all night. 0 = no cap.
 */
export type SeedRule = {
  activity: HxpActivity
  label: string
  description: string
  points: number
  bonusPoints: number
  bonusThreshold: number
  dailyCap: number
}

export const DEFAULT_POINTS_RULES: SeedRule[] = [
  {
    activity: 'reading',
    label: 'Reading',
    description: 'Awarded after a chapter or document has been read through.',
    points: 10,
    bonusPoints: 0,
    bonusThreshold: 0,
    dailyCap: 100,
  },
  {
    activity: 'notes',
    label: 'Taking notes',
    description: 'Awarded for a note attached to a file or video you studied.',
    points: 15,
    bonusPoints: 5,
    bonusThreshold: 200,
    dailyCap: 120,
  },
  {
    activity: 'test',
    label: 'Conducting a test',
    description: 'Awarded for finishing a test. A score at or above the threshold adds the bonus.',
    points: 25,
    bonusPoints: 15,
    bonusThreshold: 80,
    dailyCap: 200,
  },
  {
    activity: 'video',
    label: 'Watching a video',
    description: 'Awarded once the video has been watched to the end (or the reported % passes the threshold).',
    points: 10,
    bonusPoints: 5,
    bonusThreshold: 90,
    dailyCap: 100,
  },
]

export type SeedFeature = {
  key: string
  title: string
  summary: string
  description: string
  category: string
  icon: string
  status: string
  sortOrder: number
  targetRelease: string | null
}

/**
 * The Coming Soon catalogue.
 *
 * These are announcements, not hidden switches: seeding them is what makes the
 * page say something on a fresh deployment. Every value is editable afterwards
 * through `PATCH /api/admin/coming-soon/:id`, and re-seeding never overwrites an
 * administrator's edits (see `seedComingSoon`).
 */
export const DEFAULT_FEATURES: SeedFeature[] = [
  {
    key: 'songs-library',
    title: 'Songs library',
    summary: 'Browse, search and play study tracks straight from 9Drive.',
    description:
      'A music library that sits in the same place as your files: playlists per subject, focus and ambient collections, and playback that keeps going while you read. Listing songs is the first step — streaming, playlists and offline caching follow.',
    category: 'Library',
    icon: 'Music',
    status: 'coming_soon',
    sortOrder: 10,
    targetRelease: 'Q1 2027',
  },
  {
    key: 'hxp-points',
    title: 'HXP points',
    summary: 'Earn points for reading, taking notes, testing yourself and watching videos.',
    description:
      'Every study action becomes measurable. Read a chapter, write notes, finish a test or watch a video to the end, and HXP points land in your ledger. Administrators set what each activity is worth, so a school can make tests weigh more than reading.',
    category: 'Progress',
    icon: 'Trophy',
    status: 'coming_soon',
    sortOrder: 20,
    targetRelease: 'Q1 2027',
  },
  {
    key: 'hxp-leaderboard',
    title: 'Leaderboards',
    summary: 'See how your HXP compares with your class, updated weekly.',
    description:
      'Weekly and all-time standings built from the same ledger that funds HXP, with an opt-out for anyone who would rather keep their progress private.',
    category: 'Progress',
    icon: 'BarChart3',
    status: 'coming_soon',
    sortOrder: 30,
    targetRelease: null,
  },
  {
    key: 'smart-recall',
    title: 'Smart recall',
    summary: 'Turn any document into spaced-repetition flashcards.',
    description:
      'Generates question cards from the files you already stored, then schedules reviews so the material comes back at the right moment instead of all at once.',
    category: 'Learning',
    icon: 'BrainCircuit',
    status: 'coming_soon',
    sortOrder: 40,
    targetRelease: null,
  },
  {
    key: 'study-rooms',
    title: 'Study rooms',
    summary: 'Share a folder and study it together, in real time.',
    description:
      'A shared space for a small group: one shared shelf, a common notes pad, and a live activity feed so everyone can see what has been read.',
    category: 'Collaboration',
    icon: 'Users',
    status: 'coming_soon',
    sortOrder: 50,
    targetRelease: null,
  },
  {
    key: 'offline-packs',
    title: 'Offline study packs',
    summary: 'Download a subject and keep working without a connection.',
    description:
      'Bundle a folder, its notes and a test into one downloadable pack. Progress is recorded locally and synced to HXP the next time the device is online.',
    category: 'Library',
    icon: 'Download',
    status: 'coming_soon',
    sortOrder: 60,
    targetRelease: null,
  },
  {
    key: 'mobile-app',
    title: 'Mobile app',
    summary: 'The same library in your pocket, with background uploads.',
    description:
      'A native shell around the existing API: background uploads from the camera roll, offline reading, and push notifications when a new test is assigned.',
    category: 'Platform',
    icon: 'Smartphone',
    status: 'coming_soon',
    sortOrder: 70,
    targetRelease: null,
  },
]

export type SeedSong = {
  title: string
  artist: string
  album: string | null
  durationSeconds: number
  genre: string
  collection: string
  sortOrder: number
}

/**
 * Placeholder tracks for the Songs preview.
 *
 * Deliberately generic: this seeds a *layout* to look at, and a real school
 * replaces the rows with its own catalogue. No artwork URL is set, so the tile
 * renders a generated cover and no external image can fail to load.
 */
export const DEFAULT_SONGS: SeedSong[] = [
  { title: 'Deep Focus', artist: 'Study Loop', album: 'Concentration', durationSeconds: 214, genre: 'focus', collection: 'Focus', sortOrder: 10 },
  { title: 'Library Rain', artist: 'Quiet Hours', album: 'Ambient Study', durationSeconds: 187, genre: 'ambient', collection: 'Focus', sortOrder: 20 },
  { title: 'Morning Revision', artist: 'Study Loop', album: 'Concentration', durationSeconds: 231, genre: 'focus', collection: 'Focus', sortOrder: 30 },
  { title: 'Equation Drift', artist: 'Slow Maths', album: 'Problem Sets', durationSeconds: 268, genre: 'study', collection: 'Study', sortOrder: 40 },
  { title: 'Page Turns', artist: 'Quiet Hours', album: 'Ambient Study', durationSeconds: 203, genre: 'ambient', collection: 'Study', sortOrder: 50 },
  { title: 'Night Before', artist: 'Slow Maths', album: 'Problem Sets', durationSeconds: 245, genre: 'study', collection: 'Study', sortOrder: 60 },
]

/** Where a seeded song tile gets its artwork when none is stored. */
export function songArtwork(title: string, artist: string) {
  // Two stable initials, so a tile is recognisable without an image request.
  const letters = `${title.charAt(0)}${artist.charAt(0)}`.toUpperCase()
  return letters
}
