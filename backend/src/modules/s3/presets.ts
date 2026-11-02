import { looksLikePlaceholder } from '../../utils/placeholder.js'

/**
 * Storage backends described by environment variables.
 *
 * `POST /connected-accounts/s3` used to require the browser to send bucket, region,
 * endpoint, key ID and secret every time. A deployment that already holds those as
 * `B2_*` / `IDRIVE_E2_*` / `DBBYTE_*` had no way to use them: the variables were
 * read by nothing. Here each provider is described once, the server resolves the
 * credentials, and the browser only has to say *which* backend to connect - the
 * secrets never travel to the client.
 *
 * Rules carried over from the Google OAuth incident: a placeholder is not a
 * credential, and a half-configured backend reports exactly which variable is
 * missing instead of failing with an opaque SDK error at connect time.
 */

export type StorageBackendId = 'b2' | 'idrive_e2' | 'dbyte'

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
  notes: string[]
  required: Array<[string, string | null]>
}

/**
 * Backblaze B2. The S3-compatible endpoint is derivable from the region
 * (`s3.<region>.backblazeb2.com`), and `B2_ENDPOINT_URL` wins when set.
 */
function resolveB2(): Resolved {
  const bucket = readEnv('B2_BUCKET')
  const region = readEnv('B2_REGION')
  const explicitEndpoint = readEnv('B2_ENDPOINT_URL')
  const endpoint = explicitEndpoint ?? (region ? `https://s3.${region}.backblazeb2.com` : null)
  const quota = megabytesToBytes('B2_STORAGE_MAX_MB')
  const notes: string[] = ['Backblaze B2 needs path-style addressing; it is enabled for you.']
  if (quota.note) notes.push(quota.note)
  if (explicitEndpoint) notes.push('Endpoint came from B2_ENDPOINT_URL.')

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
  const endpoint = readEnv('IDRIVE_E2_ENDPOINT_URL')
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
 * DBBYTE. Only an API key and a bucket are documented for it, so the key is used as
 * both halves of the S3 credential unless `DBBYTE_KEY_ID` / `DBBYTE_SECRET_KEY` are
 * supplied separately, and the endpoint must be provided (`DBBYTE_ENDPOINT_URL`).
 */
function resolveDbyte(): Resolved {
  const apiKey = readEnv('DBBYTE_API_KEY')
  const endpoint = readEnv('DBBYTE_ENDPOINT_URL')
  const notes: string[] = []
  if (!endpoint) {
    notes.push('DBBYTE_ENDPOINT_URL is required: paste the S3 endpoint from the DBBYTE dashboard.')
  }
  if (apiKey && !readEnv('DBBYTE_SECRET_KEY')) {
    notes.push('Using DBBYTE_API_KEY as both the access key and the secret. Set DBBYTE_KEY_ID / DBBYTE_SECRET_KEY if DBBYTE issues a pair.')
  }
  return {
    bucket: readEnv('DBBYTE_BUCKET'),
    region: readEnv('DBBYTE_REGION') ?? 'us-east-1',
    endpoint,
    accessKeyId: readEnv('DBBYTE_KEY_ID') ?? apiKey,
    secretAccessKey: readEnv('DBBYTE_SECRET_KEY') ?? apiKey,
    quotaBytes: null,
    notes,
    required: [
      ['DBBYTE_API_KEY', apiKey],
      ['DBBYTE_BUCKET', readEnv('DBBYTE_BUCKET')],
      ['DBBYTE_ENDPOINT_URL', endpoint],
    ],
  }
}

const DEFINITIONS: Array<{ id: StorageBackendId; label: string; name: string; pathStyle: boolean; resolve: () => Resolved }> = [
  { id: 'b2', label: 'Backblaze B2', name: 'Backblaze B2', pathStyle: true, resolve: resolveB2 },
  { id: 'idrive_e2', label: 'IDrive E2', name: 'IDrive E2', pathStyle: true, resolve: resolveIdriveE2 },
  { id: 'dbyte', label: 'DBBYTE', name: 'DBBYTE', pathStyle: true, resolve: resolveDbyte },
]

/** Every backend the environment describes, including incomplete ones. */
export function listStoragePresets(): StoragePreset[] {
  return DEFINITIONS.map((definition) => {
    const resolved = definition.resolve()
    const missing = resolved.required.filter(([, value]) => !value).map(([name]) => name)
    const env = resolved.required.map(([name]) => ({ name, state: envState(name) }))
    const emptyVars = env.filter((entry) => entry.state === 'empty' || entry.state === 'placeholder').map((entry) => entry.name)
    const unsetVars = env.filter((entry) => entry.state === 'unset').map((entry) => entry.name)
    return {
      id: definition.id,
      label: definition.label,
      name: definition.name,
      bucket: resolved.bucket,
      region: resolved.region,
      endpoint: resolved.endpoint,
      forcePathStyle: definition.pathStyle,
      hasAccessKey: Boolean(resolved.accessKeyId),
      hasSecretKey: Boolean(resolved.secretAccessKey),
      quotaBytes: resolved.quotaBytes,
      missing,
      emptyVars,
      unsetVars,
      env,
      ready: missing.length === 0,
      notes: resolved.notes,
    }
  })
}

export function getStoragePreset(id: string): StoragePreset | undefined {
  return listStoragePresets().find((preset) => preset.id === id)
}

/**
 * The backend `STORAGE_BACKEND` names. Falls back to the only ready backend, so a
 * deployment that forgot to set it still works when exactly one is complete.
 */
export function resolveActivePreset(): StoragePreset | null {
  const presets = listStoragePresets()
  const requested = process.env.STORAGE_BACKEND?.trim().toLowerCase()
  if (requested) {
    const named = presets.find((preset) => preset.id === requested)
    if (named) return named
    console.warn(`[storage] STORAGE_BACKEND="${requested}" is not a known backend. Use one of: ${presets.map((p) => p.id).join(', ')}.`)
  }
  const ready = presets.filter((preset) => preset.ready)
  return ready.length === 1 ? ready[0]! : null
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
    })),
  }
}
