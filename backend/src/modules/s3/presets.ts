import { looksLikePlaceholder } from '../../utils/placeholder.js'

/**
 * Storage backends described by environment variables.
 *
 * `POST /connected-accounts/s3` used to require the browser to send bucket, region,
 * endpoint, key ID and secret every time. A deployment that already holds those as
 * environment variables had no way to use them: they were read by nothing. Here each
 * provider is described once, the server resolves the credentials, and the browser
 * only has to say *which* backend to connect - the secrets never travel to the client.
 *
 * Rules carried over from the Google OAuth incident: a placeholder is not a
 * credential, and a half-configured backend reports exactly which variable is
 * missing instead of failing with an opaque SDK error at connect time.
 *
 * `custom` (`S3_*`) covers every other S3-compatible cloud - Storj, Hetzner, Tigris,
 * DigitalOcean Spaces, Linode, Scaleway, MinIO, AWS itself - so a new provider needs
 * variables, not code.
 */

export type StorageBackendId = 'b2' | 'idrive_e2' | 'tigris' | 'custom'

/**
 * State of one environment variable, without ever exposing its value.
 *
 * The live deployment had `B2_KEY_ID` and friends listed in Render's Environment
 * tab but with **empty values** - which looked configured and behaved exactly like
 * "not set". Distinguishing the two turns a guessing game into one instruction.
 */
export type EnvVarState = 'ok' | 'empty' | 'unset' | 'placeholder'

export type EnvVarReport = { name: string; state: EnvVarState }

export type StoragePreset = {
  id: StorageBackendId
  label: string
  /** Display name used for the connected account. */
  name: string
  bucket: string | null
  region: string | null
  endpoint: string | null
  forcePathStyle: boolean
  hasAccessKey: boolean
  hasSecretKey: boolean
  /** JSON-friendly so the API can send it unchanged. */
  quotaBytes: string | null
  /** Environment variable names that are absent, empty or still placeholders. */
  missing: string[]
  /** Which of those exist on the service but have no value. */
  emptyVars: string[]
  /** Which of those are not defined at all. */
  unsetVars: string[]
  /** Per-variable state, for diagnostics. */
  env: EnvVarReport[]
  ready: boolean
  notes: string[]
  /** Where the credentials come from, shown in Settings. */
  credentialsHint: string
}

function envState(name: string): EnvVarState {
  const raw = process.env[name]
  if (raw === undefined) return 'unset'
  const trimmed = raw.trim()
  if (!trimmed) return 'empty'
  if (looksLikePlaceholder(trimmed)) return 'placeholder'
  return 'ok'
}

function readEnv(name: string): string | null {
  const raw = process.env[name]?.trim()
  if (!raw || looksLikePlaceholder(raw)) return null
  return raw
}

/**
 * The first of several acceptable names.
 *
 * Dashboards and tutorials disagree about names (`TIGRIS_KEY_ID` vs
 * `TIGRIS_ACCESS_KEY`), and a value typed under the "wrong" name looked exactly
 * like nothing configured. Both work; the canonical name is what diagnostics lists.
 */
function readAny(...names: string[]): string | null {
  for (const name of names) {
    const value = readEnv(name)
    if (value) return value
  }
  return null
}

/**
 * An S3 endpoint as the SDK needs it: absolute, https, no trailing slash.
 *
 * `B2_ENDPOINT_URL=s3.ca-east-006.backblazeb2.com` (no scheme) is what the live
 * deployment had - the AWS SDK rejects that as an invalid URL, so the connect
 * attempt failed for a reason that looked like a credential problem. Accepting the
 * bare host is both friendlier and unambiguous.
 */
export function normalizeEndpoint(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!url.hostname || url.hostname.startsWith('.') || url.hostname.endsWith('.')) return null
    // A path is kept (some providers serve S3 under one); a bare "/" is not.
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return null
  }
}

/** Region encoded in a Backblaze endpoint (`s3.<region>.backblazeb2.com`). */
function b2RegionFromEndpoint(endpoint: string | null): string | null {
  if (!endpoint) return null
  const match = /^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint)
  return match?.[1] ?? null
}

const MEGABYTE = 1024n * 1024n

function megabytesToBytes(name: string): { value: string | null; note?: string } {
  const raw = readEnv(name)
  if (!raw) return { value: null }
  if (!/^\d+$/.test(raw)) {
    return { value: null, note: `${name} must be a whole number of megabytes (got "${raw}").` }
  }
  return { value: (BigInt(raw) * MEGABYTE).toString() }
}

type Resolved = {
  bucket: string | null
  region: string | null
  endpoint: string | null
  accessKeyId: string | null
  secretAccessKey: string | null
  quotaBytes: string | null
  forcePathStyle?: boolean
  /** Overrides the static label, e.g. `S3_LABEL=Hetzner`. */
  name?: string
  notes: string[]
  required: Array<[string, string | null]>
}

/** Note when a typed endpoint had to be repaired, so the console value gets fixed. */
function endpointNote(raw: string | null, normalized: string | null): string | null {
  if (!raw) return null
  if (!normalized) return `The endpoint "${raw}" is not a usable URL - use the provider's S3 API host, e.g. https://s3.us-east-1.amazonaws.com.`
  if (raw.trim().replace(/\/+$/, '') !== normalized) return `Endpoint normalised to ${normalized} (from "${raw}").`
  return null
}

/**
 * Backblaze B2. The S3-compatible endpoint is derivable from the region
 * (`s3.<region>.backblazeb2.com`), and `B2_ENDPOINT_URL` wins when set.
 */
function resolveB2(): Resolved {
  const bucket = readEnv('B2_BUCKET')
  const region = readEnv('B2_REGION')
  const explicitEndpoint = readEnv('B2_ENDPOINT_URL')
  const endpoint = normalizeEndpoint(explicitEndpoint) ?? (region ? normalizeEndpoint(`s3.${region}.backblazeb2.com`) : null)
  const quota = megabytesToBytes('B2_STORAGE_MAX_MB')
  const notes: string[] = ['Backblaze B2 needs path-style addressing; it is enabled for you.']
  if (quota.note) notes.push(quota.note)
  const normalised = endpointNote(explicitEndpoint, endpoint)
  if (normalised) notes.push(normalised)

  // Backblaze signs requests with the bucket's region. A region that disagrees with
  // the endpoint produces SignatureDoesNotMatch on every upload.
  const endpointRegion = b2RegionFromEndpoint(endpoint)
  if (endpointRegion && region && endpointRegion !== region) {
    notes.push(`B2_REGION is "${region}" but the endpoint is for "${endpointRegion}". Use B2_REGION=${endpointRegion}, or clear B2_ENDPOINT_URL to derive it.`)
  }
  if (bucket && /[A-Z]/.test(bucket)) {
    notes.push(`B2_BUCKET "${bucket}" contains capitals. Backblaze bucket names are lowercase - use the exact name from the B2 console.`)
  }

  return {
    bucket,
    region,
    endpoint,
    accessKeyId: readEnv('B2_KEY_ID'),
    secretAccessKey: readEnv('B2_APPLICATION_KEY'),
    quotaBytes: quota.value,
    notes,
    required: [
      ['B2_KEY_ID', readEnv('B2_KEY_ID')],
      ['B2_APPLICATION_KEY', readEnv('B2_APPLICATION_KEY')],
      ['B2_BUCKET', bucket],
      ['B2_REGION', region],
    ],
  }
}

/**
 * IDrive E2. The endpoint is per-account and cannot be guessed, so it is required
 * (`IDRIVE_E2_ENDPOINT_URL`, copied from the IDrive console).
 */
function resolveIdriveE2(): Resolved {
  const endpoint = normalizeEndpoint(readEnv('IDRIVE_E2_ENDPOINT_URL'))
  const notes: string[] = []
  if (!endpoint) {
    notes.push('Copy the endpoint from the IDrive E2 console into IDRIVE_E2_ENDPOINT_URL (it looks like https://abc12.va.idrivee2-18.com).')
  }
  return {
    bucket: readEnv('IDRIVE_E2_BUCKET'),
    region: readEnv('IDRIVE_E2_REGION') ?? 'us-east-1',
    endpoint,
    accessKeyId: readEnv('IDRIVE_E2_KEY_ID'),
    secretAccessKey: readEnv('IDRIVE_E2_SECRET_KEY'),
    quotaBytes: null,
    notes,
    required: [
      ['IDRIVE_E2_KEY_ID', readEnv('IDRIVE_E2_KEY_ID')],
      ['IDRIVE_E2_SECRET_KEY', readEnv('IDRIVE_E2_SECRET_KEY')],
      ['IDRIVE_E2_BUCKET', readEnv('IDRIVE_E2_BUCKET')],
      ['IDRIVE_E2_ENDPOINT_URL', endpoint],
    ],
  }
}

/**
 * Tigris - a globally distributed S3-compatible store.
 *
 * One endpoint (`https://t3.storage.dev`), region `auto`, path-style addressing.
 * On Fly.io the endpoint is `https://fly.storage.tigris.dev` instead, so it is
 * overridable. Credentials are an access key ID + secret access key pair created
 * in the Tigris console (`tigris.dev` -> Access keys).
 *
 * Filebase used to live here and was removed: its object-storage buckets answered
 * `NotFound - UnknownError` on every connect attempt from this deployment, because
 * the bucket and the key belonged to the IPFS tier (`s3.filebase.com`, us-east-1),
 * and a preset that cannot connect is worse than no preset.
 */
function resolveTigris(): Resolved {
  const explicitEndpoint = readEnv('TIGRIS_ENDPOINT_URL')
  const endpoint = normalizeEndpoint(explicitEndpoint) ?? 'https://t3.storage.dev'
  const region = readEnv('TIGRIS_REGION') ?? 'auto'
  const quota = megabytesToBytes('TIGRIS_STORAGE_MAX_MB')
  const notes: string[] = [
    'Tigris: endpoint https://t3.storage.dev, region auto, path-style. Set TIGRIS_ENDPOINT_URL=https://fly.storage.tigris.dev if the bucket was created inside Fly.io.',
  ]
  if (quota.note) notes.push(quota.note)
  const normalised = endpointNote(explicitEndpoint, endpoint)
  if (normalised) notes.push(normalised)
  if (/filebase/i.test(endpoint)) {
    notes.push('That endpoint belongs to a different provider - Tigris is https://t3.storage.dev.')
  }
  const accessKeyId = readAny('TIGRIS_KEY_ID', 'TIGRIS_ACCESS_KEY', 'TIGRIS_ACCESS_KEY_ID')
  const secretAccessKey = readAny('TIGRIS_SECRET_KEY', 'TIGRIS_SECRET_ACCESS_KEY')
  const bucket = readAny('TIGRIS_BUCKET', 'TIGRIS_BUCKET_NAME')

  return {
    bucket,
    region,
    endpoint,
    accessKeyId,
    secretAccessKey,
    quotaBytes: quota.value,
    notes,
    required: [
      ['TIGRIS_KEY_ID', accessKeyId],
      ['TIGRIS_SECRET_KEY', secretAccessKey],
      ['TIGRIS_BUCKET', bucket],
    ],
  }
}

/** `"true"`/`"1"`/`"yes"` - anything else is a note, not a silent default. */
function readBoolean(name: string, fallback: boolean): { value: boolean; note?: string } {
  const raw = readEnv(name)
  if (!raw) return { value: fallback }
  if (/^(1|true|yes|on)$/i.test(raw)) return { value: true }
  if (/^(0|false|no|off)$/i.test(raw)) return { value: false }
  return { value: fallback, note: `${name} should be true or false (got "${raw}").` }
}

/**
 * Any other S3-compatible provider, described by `S3_*`.
 *
 * Storj, Hetzner, Tigris, DigitalOcean Spaces, Linode, Scaleway, MinIO, AWS, and
 * anything else: the endpoint, region and path-style behaviour are the only things
 * that differ, and all three are variables here.
 */
function resolveCustom(): Resolved {
  const endpoint = normalizeEndpoint(readEnv('S3_ENDPOINT_URL'))
  const bucket = readEnv('S3_BUCKET')
  const region = readEnv('S3_REGION') ?? 'us-east-1'
  const pathStyle = readBoolean('S3_FORCE_PATH_STYLE', Boolean(endpoint))
  const quota = megabytesToBytes('S3_STORAGE_MAX_MB')
  const label = readEnv('S3_LABEL')

  const notes: string[] = []
  if (!endpoint) notes.push('S3_ENDPOINT_URL is required for a non-AWS provider (AWS itself needs no endpoint, but this preset expects one).')
  if (pathStyle.note) notes.push(pathStyle.note)
  if (quota.note) notes.push(quota.note)
  if (!bucket) notes.push('Set S3_BUCKET to the bucket name exactly as the provider lists it.')

  return {
    bucket,
    region,
    endpoint,
    accessKeyId: readEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: readEnv('S3_SECRET_ACCESS_KEY'),
    quotaBytes: quota.value,
    forcePathStyle: pathStyle.value,
    name: label ?? 'S3 compatible',
    notes,
    required: [
      ['S3_ENDPOINT_URL', endpoint],
      ['S3_BUCKET', bucket],
      ['S3_ACCESS_KEY_ID', readEnv('S3_ACCESS_KEY_ID')],
      ['S3_SECRET_ACCESS_KEY', readEnv('S3_SECRET_ACCESS_KEY')],
    ],
  }
}

type Definition = {
  id: StorageBackendId
  label: string
  name: string
  pathStyle: boolean
  credentialsHint: string
  /** Hidden until one of its variables is set: a permanently-empty row is noise. */
  hideWhenUnconfigured?: boolean
  /** Variables that count as "this backend was configured at all". */
  presenceVars?: string[]
  resolve: () => Resolved
}

function isConfigured(definition: Definition): boolean {
  if (!definition.presenceVars?.length) return true
  return definition.presenceVars.some((name) => envState(name) !== 'unset')
}

/**
 * `dbyte` was removed: DBByte's API is REST + bearer token (base URL
 * https://api.dbbyte.com), with no S3 endpoint and a 100 MB upload cap, so it can
 * never work through this route. Its variables are simply ignored now.
 */
const DEFINITIONS: Definition[] = [
  {
    id: 'b2',
    label: 'Backblaze B2',
    name: 'Backblaze B2',
    pathStyle: true,
    credentialsHint: 'B2 console -> Application Keys: keyID goes in B2_KEY_ID, applicationKey in B2_APPLICATION_KEY. B2_REGION is the region in the bucket endpoint (s3.<region>.backblazeb2.com).',
    resolve: resolveB2,
  },
  {
    id: 'idrive_e2',
    label: 'IDrive E2',
    name: 'IDrive E2',
    pathStyle: true,
    credentialsHint: 'IDrive E2 console -> Access Keys: IDRIVE_E2_KEY_ID + IDRIVE_E2_SECRET_KEY, and copy the per-account endpoint into IDRIVE_E2_ENDPOINT_URL.',
    resolve: resolveIdriveE2,
  },
  {
    id: 'tigris',
    label: 'Tigris',
    name: 'Tigris',
    pathStyle: true,
    credentialsHint: 'Tigris console -> Access keys: TIGRIS_KEY_ID + TIGRIS_SECRET_KEY, and TIGRIS_BUCKET. Endpoint is https://t3.storage.dev, region auto (override both for Fly.io).',
    resolve: resolveTigris,
  },
  {
    id: 'custom',
    label: 'S3 compatible',
    name: 'S3 compatible',
    pathStyle: true,
    credentialsHint: 'Generic: S3_ENDPOINT_URL, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (+ S3_FORCE_PATH_STYLE, S3_LABEL, S3_STORAGE_MAX_MB). Use for Storj, Hetzner, Tigris, DigitalOcean, Linode, Scaleway, MinIO, AWS.',
    hideWhenUnconfigured: true,
    presenceVars: ['S3_ENDPOINT_URL', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_LABEL'],
    resolve: resolveCustom,
  },
]

/** Every backend the environment describes, including incomplete ones. */
export function listStoragePresets(): StoragePreset[] {
  return DEFINITIONS.filter((definition) => !definition.hideWhenUnconfigured || isConfigured(definition)).map((definition) => {
    const resolved = definition.resolve()
    const missing = resolved.required.filter(([, value]) => !value).map(([name]) => name)
    // A value supplied under an accepted alias counts as configured.
    const env = resolved.required.map(([name, value]) => ({ name, state: value ? 'ok' : envState(name) }))
    const emptyVars = env.filter((entry) => entry.state === 'empty' || entry.state === 'placeholder').map((entry) => entry.name)
    const unsetVars = env.filter((entry) => entry.state === 'unset').map((entry) => entry.name)
    return {
      id: definition.id,
      label: definition.label,
      name: resolved.name ?? definition.name,
      bucket: resolved.bucket,
      region: resolved.region,
      endpoint: resolved.endpoint,
      forcePathStyle: resolved.forcePathStyle ?? definition.pathStyle,
      hasAccessKey: Boolean(resolved.accessKeyId),
      hasSecretKey: Boolean(resolved.secretAccessKey),
      quotaBytes: resolved.quotaBytes,
      missing,
      emptyVars,
      unsetVars,
      env,
      ready: missing.length === 0,
      notes: resolved.notes,
      credentialsHint: definition.credentialsHint,
    }
  })
}

export function getStoragePreset(id: string): StoragePreset | undefined {
  return listStoragePresets().find((preset) => preset.id === id)
}

/** The ids a caller may name, for error messages and validation. */
export function storageBackendIds(): StorageBackendId[] {
  return DEFINITIONS.map((definition) => definition.id)
}

/**
 * Names people actually type in `STORAGE_BACKEND`, beyond the canonical ids. The
 * live deployment set `s3`, which matched nothing and silently disabled the
 * selection.
 */
const BACKEND_ALIASES: Record<string, StorageBackendId> = {
  b2: 'b2',
  backblaze: 'b2',
  backblaze_b2: 'b2',
  'backblaze-b2': 'b2',
  idrive: 'idrive_e2',
  idrive_e2: 'idrive_e2',
  'idrive-e2': 'idrive_e2',
  idrivee2: 'idrive_e2',
  tigris: 'tigris',
  tigris_storage: 'tigris',
  custom: 'custom',
  generic: 'custom',
  s3_gen: 'custom',
  s3_generic: 'custom',
}

/**
 * The backend `STORAGE_BACKEND` names, in preference order (a comma-separated list
 * is accepted). Without a usable value the first ready backend is used, so a
 * deployment with two configured backends still preselects one instead of none.
 */
export function resolveActivePreset(): StoragePreset | null {
  const presets = listStoragePresets()
  const requested = process.env.STORAGE_BACKEND?.trim().toLowerCase()

  if (requested) {
    const wanted = requested.split(',').map((entry) => entry.trim()).filter(Boolean)
    for (const name of wanted) {
      // "s3" is a family, not a backend - treat it as "whatever is ready".
      if (name === 's3' || name === 'auto' || name === 's3_compatible') continue
      const id = BACKEND_ALIASES[name]
      const named = id ? presets.find((preset) => preset.id === id) : undefined
      if (named && named.ready) return named
      if (named) {
        console.warn(`[storage] STORAGE_BACKEND names ${named.label}, but it is incomplete: ${named.missing.join(', ')}.`)
        continue
      }
      console.warn(`[storage] STORAGE_BACKEND="${name}" is not a known backend. Use one of: ${presets.map((p) => p.id).join(', ')}, or a comma-separated preference list.`)
    }
  }

  return presets.find((preset) => preset.ready) ?? null
}

/** Credentials for a backend, for the server side only. Never serialise this. */
export function resolvePresetCredentials(id: string): { accessKeyId: string; secretAccessKey: string } | null {
  const definition = DEFINITIONS.find((entry) => entry.id === id)
  if (!definition) return null
  const resolved = definition.resolve()
  if (!resolved.accessKeyId || !resolved.secretAccessKey) return null
  return { accessKeyId: resolved.accessKeyId, secretAccessKey: resolved.secretAccessKey }
}

/** Human summary for `/api/diagnostics` - variable names only, never values. */
export function describeStorageEnvironment() {
  const presets = listStoragePresets()
  const active = resolveActivePreset()
  return {
    backend: process.env.STORAGE_BACKEND?.trim() || null,
    active: active?.id ?? null,
    presets: presets.map((preset) => ({
      id: preset.id,
      label: preset.label,
      ready: preset.ready,
      missing: preset.missing,
      emptyVars: preset.emptyVars,
      unsetVars: preset.unsetVars,
      env: preset.env,
      bucket: preset.bucket,
      endpoint: preset.endpoint,
      region: preset.region,
      // Normalisation and region/bucket warnings travel with the report, so a
      // pasted /api/diagnostics explains the problem on its own.
      notes: preset.notes,
    })),
  }
}
