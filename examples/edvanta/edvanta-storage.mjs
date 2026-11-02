/**
 * Edvanta -> EduBrixVora storage client (server-side only).
 *
 * No dependencies. Node 18+, Bun, Deno and any runtime with fetch/FormData.
 * The API key stays on Edvanta's server; browsers receive only short-lived URLs.
 * This module never talks directly to Google Drive or S3.
 */
const DEFAULT_TIMEOUT_MS = 15_000

export class StorageError extends Error {
  constructor(message, { status = 0, code = 'STORAGE_ERROR', hint = null, body = null } = {}) {
    super(message)
    this.name = 'StorageError'
    this.status = status
    this.code = code
    this.hint = hint
    this.body = body
  }
}

/* Edvanta deployments have used both STORAGE_* and NINE_DRIVE_* names. Accept
 * both so an existing Render environment does not need renaming. */
const ENDPOINT_ENV_KEYS = ['STORAGE_ENDPOINT', 'NINE_DRIVE_API_URL', 'NINE_DRIVE_URL', 'NINE_DRIVE_BASE_URL']
const API_KEY_ENV_KEYS = ['STORAGE_API_KEY', 'NINE_DRIVE_API_KEY']
const TIMEOUT_ENV_KEYS = ['STORAGE_TIMEOUT_MS', 'NINE_DRIVE_TIMEOUT_MS']

function firstEnv(keys) {
  for (const key of keys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * The deployed API is `/api/v1`. Accept a bare origin, `/api`, `/api/v1`, a
 * stray `/v1`, or a bare hostname and normalise without ever echoing a key.
 * Query strings/credentials are dropped so a pasted secret cannot leak.
 */
export function normalizeStorageEndpoint(value) {
  let raw = (value ?? '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new StorageError('The 9Drive URL is not a valid HTTP(S) URL.', { code: 'STORAGE_CONFIG_MISSING' })
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  let path = url.pathname.replace(/\/+$/, '')
  if (!path || path === '/') path = '/api/v1'
  else if (path === '/api' || path.endsWith('/api')) path = `${path}/v1`
  else if (path.endsWith('/v1') && !path.includes('/api/v1')) path = path.replace(/\/v1$/, '/api/v1')
  else if (!path.includes('/api/v1')) path = `${path}/api/v1`
  url.pathname = path
  return url.toString().replace(/\/+$/, '')
}

function fromEnvironment() {
  const endpoint = normalizeStorageEndpoint(firstEnv(ENDPOINT_ENV_KEYS))
  const apiKey = firstEnv(API_KEY_ENV_KEYS)
  const rawTimeout = firstEnv(TIMEOUT_ENV_KEYS)
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS
  return { endpoint, apiKey, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS }
}

function timeoutSignal(ms, callerSignal) {
  if (callerSignal) return callerSignal
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  return controller.signal
}

function query(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export function createStorage(options = {}) {
  const env = fromEnvironment()
  const endpoint = normalizeStorageEndpoint(options.endpoint ?? env.endpoint)
  const apiKey = options.apiKey ?? env.apiKey
  const timeoutMs = options.timeoutMs ?? env.timeoutMs
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  if (!endpoint) throw new StorageError('Set STORAGE_ENDPOINT or NINE_DRIVE_API_URL on the Edvanta server.', { code: 'STORAGE_CONFIG_MISSING' })
  if (!apiKey) throw new StorageError('Set STORAGE_API_KEY or NINE_DRIVE_API_KEY on the Edvanta server.', { code: 'STORAGE_CONFIG_MISSING' })
  if (typeof fetchImpl !== 'function') throw new StorageError('This runtime has no fetch implementation.', { code: 'STORAGE_CONFIG_MISSING' })

  async function rawRequest(path, init = {}) {
    const headers = new Headers(init.headers ?? {})
    headers.set('Authorization', `Bearer ${apiKey}`)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    let response
    try {
      response = await fetchImpl(`${endpoint}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        signal: timeoutSignal(timeoutMs, init.signal),
        redirect: init.redirect ?? 'follow',
      })
    } catch (error) {
      throw new StorageError(
        `The storage service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        { code: 'STORAGE_UPSTREAM_UNAVAILABLE', status: 502 },
      )
    }
    return response
  }

  async function problem(response) {
    const text = await response.text().catch(() => '')
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { message: text.slice(0, 300) }
    }
    return new StorageError(body?.message ?? `Storage API returned HTTP ${response.status}.`, {
      status: response.status,
      code: body?.code ?? 'STORAGE_HTTP_ERROR',
      hint: body?.hint ?? null,
      body,
    })
  }

  async function jsonRequest(path, init = {}) {
    const response = await rawRequest(path, init)
    if (!response.ok) throw await problem(response)
    if (response.status === 204) return null
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('application/json')) return response.text()
    return response.json()
  }

  /** Last successful counts response, used when the storage service is waking up. */
  let lastLiveCounts = null

  return {
    endpoint,
    /** Student/admin discovery. `audience=admin` is only for Edvanta's admin UI. */
    listResources(filters = {}) {
      const params = { audience: 'student', limit: 50, ...filters }
      return jsonRequest(`/resources${query(params)}`)
    },
    getResource(id, { audience = 'student' } = {}) {
      return jsonRequest(`/resources/${encodeURIComponent(id)}${query({ audience })}`)
    },
    /** Mint both URLs after Edvanta has authenticated the end user. */
    getAccess(id, { audience = 'student', ttlSeconds } = {}) {
      return jsonRequest(`/resources/${encodeURIComponent(id)}/access${query({ audience, ttlSeconds })}`)
    },
    /** 415 is not an exception: it carries a download URL for Office/unknown types. */
    async getPreviewUrl(id, { audience = 'student', ttlSeconds } = {}) {
      const response = await rawRequest(`/resources/${encodeURIComponent(id)}/preview-url${query({ audience, ttlSeconds })}`)
      const body = await response.json().catch(() => ({}))
      if (response.status === 415) {
        return { unsupported: true, previewMode: body.previewMode, reason: body.message, mimeType: body.mimeType, download: body.download }
      }
      if (!response.ok) throw await problem(response)
      return body
    },
    getDownloadUrl(id, { audience = 'student', ttlSeconds } = {}) {
      return jsonRequest(`/resources/${encodeURIComponent(id)}/download-url${query({ audience, ttlSeconds })}`)
    },
    /** Streaming ZIP. Returns the raw Response; headers report skipped files. */
    async bulkDownload(ids, { audience = 'student', signal } = {}) {
      const response = await rawRequest('/resources/bulk-download', {
        method: 'POST',
        json: { ids, audience },
        signal,
      })
      if (!response.ok) throw await problem(response)
      return {
        response,
        errorCount: Number(response.headers.get('x-resource-bulk-error-count') ?? 0),
        skipped: (response.headers.get('x-resource-bulk-skipped') ?? '').split(',').filter(Boolean),
      }
    },
    /**
     * Admin upload. `file` may be a File/Blob or a Node Buffer. `resourceMeta`
     * must include title and sizeBytes; clientRequestId makes retries safe.
     */
    async uploadResource({ file, fileName, mimeType, resourceMeta, signal }) {
      if (!file) throw new StorageError('uploadResource needs a file.', { code: 'STORAGE_INPUT_INVALID', status: 400 })
      const sizeBytes = resourceMeta?.sizeBytes ?? file.size ?? (typeof file.length === 'number' ? file.length : undefined)
      if (!sizeBytes) throw new StorageError('resourceMeta.sizeBytes is required for streaming upload routing.', { code: 'STORAGE_INPUT_INVALID', status: 400 })
      const blob = typeof Blob !== 'undefined' && file instanceof Blob ? file : new Blob([file], { type: mimeType ?? 'application/octet-stream' })
      const form = new FormData()
      form.append('resourceMeta', JSON.stringify({ ...resourceMeta, sizeBytes: String(sizeBytes), fileName: fileName ?? file.name, mimeType: mimeType ?? file.type }))
      form.append('file', blob, fileName ?? file.name ?? 'resource.bin')
      return await jsonRequest('/resources', { method: 'POST', body: form, signal })
    },
    patchResource(id, patch) {
      return jsonRequest(`/resources/${encodeURIComponent(id)}`, { method: 'PATCH', json: patch })
    },
    deleteResource(id, { permanent = false } = {}) {
      return jsonRequest(`/resources/${encodeURIComponent(id)}${query({ permanent: permanent ? 1 : 0 })}`, { method: 'DELETE' })
    },
    verifyResource(id) {
      return jsonRequest(`/resources/${encodeURIComponent(id)}/verify`, { method: 'POST', json: {} })
    },
    syncResources({ limit = 50, cursor, order = 'newest' } = {}) {
      return jsonRequest('/resources/sync', { method: 'POST', json: { limit, cursor, order } })
    },
    /**
     * Fast live counts for the landing page.
     *
     * A Render free-tier cold start can take ~1 minute. This call uses a short
     * timeout and serves the last known counts (or an empty shape) instead of
     * blocking the whole page. `stale: true` tells the UI to skip the
     * "loading the live counts" notice; it must never be treated as an error.
     */
    async getLiveCounts({ audience = 'student', includeUnavailable = false, timeoutMs = 3000, signal } = {}) {
      const abortSignal = signal ?? timeoutSignal(timeoutMs)
      try {
        const path = `/resources/counts${query({ audience, includeUnavailable: includeUnavailable ? 1 : 0 })}`
        const response = await rawRequest(path, { signal: abortSignal })
        if (!response.ok) throw await problem(response)
        const body = await response.json()
        lastLiveCounts = { ...body, stale: false }
        return lastLiveCounts
      } catch (error) {
        if (lastLiveCounts) {
          return { ...lastLiveCounts, stale: true, note: 'Storage service is waking up; serving the last known counts.' }
        }
        return {
          counts: {
            total: 0,
            available: 0,
            missing: 0,
            inaccessible: 0,
            unknown: 0,
            byCategory: {},
            bySubject: {},
            byProvider: {},
          },
          audience,
          includeUnavailable,
          generatedAt: null,
          ttlSeconds: 0,
          cached: false,
          stale: true,
          note: 'Counts are unavailable while the storage service wakes; the page remains usable.',
          error: error?.code ?? 'STORAGE_UPSTREAM_UNAVAILABLE',
        }
      }
    },
    health() {
      return jsonRequest('/resources/health')
    },
    /**
     * Always returns a `storage` object. A consumer admin panel showing
     * "Storage status has not been reported by the API yet" only needs to read
     * this: even an unreachable 9Drive is reported as `unavailable`, never as
     * a missing field. The endpoint is safe to expose to Edvanta admins only.
     */
    async getStorageStatus({ timeoutMs = 3000, signal } = {}) {
      const abortSignal = signal ?? timeoutSignal(timeoutMs)
      const checkedAt = new Date().toISOString()
      try {
        const response = await rawRequest('/storage-status', { signal: abortSignal })
        const text = await response.text().catch(() => '')
        let body = {}
        try {
          body = text ? JSON.parse(text) : {}
        } catch {
          body = {}
        }
        if (!response.ok && !body.storage) {
          throw new StorageError(`9Drive health returned HTTP ${response.status}.`, {
            code: 'STORAGE_UPSTREAM_UNAVAILABLE',
            status: response.status,
          })
        }
        const storage = {
          status: body.storage?.status ?? (response.ok ? 'connected' : 'degraded'),
          provider: '9Drive',
          endpoint,
          database: body.storage?.database ?? body.database ?? { ok: false },
          accounts: body.storage?.accounts ?? body.accounts ?? [],
          resources: body.storage?.resources ?? body.resources ?? { available: 0, missing: 0, inaccessible: 0, unknown: 0 },
          checkedAt: body.storage?.checkedAt ?? body.checkedAt ?? checkedAt,
          reported: true,
        }
        return { storage, storageStatus: body.storageStatus ?? storage.status, reported: true }
      } catch (error) {
        const storage = {
          status: 'unavailable',
          provider: '9Drive',
          endpoint,
          database: { ok: false },
          accounts: [],
          resources: { available: 0, missing: 0, inaccessible: 0, unknown: 0 },
          checkedAt,
          reported: true,
          error: error?.code ?? 'STORAGE_UPSTREAM_UNAVAILABLE',
        }
        return {
          storage,
          storageStatus: 'unavailable',
          reported: true,
          note: '9Drive did not answer. The API has reported an unavailable storage status instead of leaving it unreported.',
        }
      }
    },
  }
}
