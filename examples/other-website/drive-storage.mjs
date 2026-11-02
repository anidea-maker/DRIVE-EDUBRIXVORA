/**
 * A tiny, dependency-free client for the 9Drive storage API.
 *
 * Copy this file into the other website's project and use it with two
 * environment variables - no AWS SDK, no credentials pair, no bucket:
 *
 *   STORAGE_ENDPOINT=https://drive-edubrixvora-1.onrender.com/api/v1
 *   STORAGE_API_KEY=9d_live_...
 *
 * Requires Node 18+ (global fetch). Works unchanged in Bun, Deno and edge
 * runtimes that provide fetch.
 *
 * Why there is no "bucket": unlike S3/B2, 9Drive has one storage pool per
 * account. Namespacing is done with a key prefix instead (see `prefix`), which
 * is the part that replaces B2_BUCKET.
 */

export class StorageError extends Error {
  /**
   * @param {number} status
   * @param {string} code    stable machine code, e.g. NO_SUCH_KEY
   * @param {string} message human sentence from the API
   * @param {string} [hint]  what to do about it
   */
  constructor(status, code, message, hint) {
    super(message)
    this.name = 'StorageError'
    this.status = status
    this.code = code
    this.hint = hint
  }
}

/** Keys are paths; encode each segment but keep the slashes. */
export function encodeKey(key) {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function joinPrefix(prefix, key) {
  const clean = String(prefix ?? '').replace(/^\/+|\/+$/g, '')
  return clean ? `${clean}/${key.replace(/^\/+/, '')}` : key.replace(/^\/+/, '')
}

function bodyLength(body) {
  if (typeof body === 'string') return Buffer.byteLength(body)
  if (body && typeof body.byteLength === 'number') return body.byteLength
  if (body && typeof body.size === 'number') return body.size
  return null
}

/**
 * @param {{
 *   endpoint?: string,
 *   apiKey?: string,
 *   prefix?: string,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export function createStorage(options = {}) {
  const endpoint = (options.endpoint ?? process.env.STORAGE_ENDPOINT ?? '').trim().replace(/\/+$/, '')
  const apiKey = (options.apiKey ?? process.env.STORAGE_API_KEY ?? '').trim()
  const prefix = options.prefix ?? process.env.STORAGE_PREFIX ?? ''
  const call = options.fetchImpl ?? globalThis.fetch

  if (!endpoint) throw new Error('STORAGE_ENDPOINT is not set (e.g. https://your-9drive.onrender.com/api/v1).')
  if (!apiKey) throw new Error('STORAGE_API_KEY is not set. Create a key in 9Drive -> Storage API.')
  if (typeof call !== 'function') throw new Error('global fetch is missing; pass fetchImpl or use Node 18+.')

  const auth = { Authorization: `Bearer ${apiKey}` }

  async function fail(response) {
    let payload = {}
    try {
      payload = await response.json()
    } catch {
      // A proxy answered with HTML (wrong STORAGE_ENDPOINT); keep the status.
    }
    return new StorageError(
      response.status,
      payload.code ?? `HTTP_${response.status}`,
      payload.message ?? `Request failed with HTTP ${response.status}.`,
      payload.hint,
    )
  }

  /** Full key as the API sees it. */
  const full = (key) => joinPrefix(prefix, key)

  return {
    endpoint,
    prefix,

    /**
     * Writes an object. The same key again overwrites it - there is never a
     * second copy.
     *
     * @param {string} key
     * @param {Buffer|Uint8Array|string|Blob} body
     * @param {{ contentType?: string }} [meta]
     * @returns {Promise<{ key: string, sizeBytes: string, etag: string | null, created: boolean }>}
     */
    async put(key, body, meta = {}) {
      const length = bodyLength(body)
      if (length === null) {
        throw new Error('put() needs a Buffer, string, Uint8Array or Blob so Content-Length is known.')
      }
      const response = await call(`${endpoint}/objects/${encodeKey(full(key))}`, {
        method: 'PUT',
        headers: {
          ...auth,
          'Content-Type': meta.contentType ?? 'application/octet-stream',
          'Content-Length': String(length),
        },
        body,
      })
      if (!response.ok) throw await fail(response)
      const data = await response.json()
      return { key: data.key, sizeBytes: data.sizeBytes, etag: data.etag, created: data.created }
    },

    /**
     * Reads an object. Returns null when the key does not exist, so callers do
     * not have to catch for the ordinary "no file yet" case.
     *
     * @returns {Promise<{ body: Buffer, contentType: string, etag: string | null, lastModified: string | null } | null>}
     */
    async get(key) {
      const response = await call(`${endpoint}/objects/${encodeKey(full(key))}`, { headers: auth })
      if (response.status === 404) return null
      if (!response.ok) throw await fail(response)
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      }
    },

    /**
     * Metadata without the bytes.
     *
     * @returns {Promise<{ sizeBytes: string, contentType: string, etag: string | null, lastModified: string | null } | null>}
     */
    async head(key) {
      const response = await call(`${endpoint}/objects/${encodeKey(full(key))}`, { method: 'HEAD', headers: auth })
      if (response.status === 404) return null
      if (!response.ok) throw await fail(response)
      return {
        sizeBytes: response.headers.get('content-length') ?? '0',
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      }
    },

    /**
     * Deletes an object. Idempotent: deleting a key that is already gone is not
     * an error, exactly like S3.
     */
    async remove(key) {
      const response = await call(`${endpoint}/objects/${encodeKey(full(key))}`, { method: 'DELETE', headers: auth })
      if (!response.ok && response.status !== 404) throw await fail(response)
      return true
    },

    /**
     * Lists objects under the configured prefix.
     *
     * `delimiter: '/'` collapses everything below the prefix into `prefixes`,
     * which is how you render folders.
     *
     * @param {{ prefix?: string, delimiter?: string, maxKeys?: number, token?: string }} [query]
     */
    async list(query = {}) {
      const params = new URLSearchParams()
      const scoped = joinPrefix(prefix, query.prefix ?? '')
      if (scoped) params.set('prefix', scoped)
      if (query.delimiter) params.set('delimiter', query.delimiter)
      if (query.maxKeys) params.set('max-keys', String(query.maxKeys))
      if (query.token) params.set('continuation-token', query.token)

      const response = await call(`${endpoint}/objects?${params.toString()}`, { headers: auth })
      if (!response.ok) throw await fail(response)
      const data = await response.json()
      return {
        objects: data.objects,
        prefixes: data.prefixes,
        isTruncated: data.isTruncated,
        nextContinuationToken: data.nextContinuationToken,
      }
    },

    /**
     * Mints a URL the browser can use for `expiresInSeconds` without holding the
     * key - an `<img src>` for reads, or a direct upload target for writes.
     *
     * @param {string} key
     * @param {{ method?: 'GET' | 'HEAD' | 'PUT', expiresInSeconds?: number }} [options]
     * @returns {Promise<{ url: string, method: string, expiresAt: string }>}
     */
    async sign(key, options = {}) {
      const response = await call(`${endpoint}/objects/sign`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: full(key),
          method: options.method ?? 'GET',
          expiresInSeconds: options.expiresInSeconds ?? 3600,
        }),
      })
      if (!response.ok) throw await fail(response)
      const data = await response.json()
      return { url: data.url, method: data.method, expiresAt: data.expiresAt }
    },
  }
}
