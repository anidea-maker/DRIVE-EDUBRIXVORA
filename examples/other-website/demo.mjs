#!/usr/bin/env node
/**
 * End-to-end walkthrough of 9Drive as another website's storage backend.
 *
 * It performs, in order, exactly what the other site does:
 *
 *   1. upload   - write bytes at a namespaced key
 *   2. list     - read back what is stored, with browser-ready URLs
 *   3. preview  - fetch the preview URL with no API key, as an <img>/<video> would
 *   4. download - fetch the same object as an attachment
 *
 * Usage:
 *
 *   STORAGE_ENDPOINT=https://your-9drive.onrender.com/api/v1 \
 *   STORAGE_API_KEY=9d_live_… \
 *   node examples/other-website/demo.mjs
 *
 * Flags:
 *   --keep   leave the uploaded objects in 9Drive (default: delete them)
 *
 * Exits 0 only if every step matched. It is therefore also a post-deploy smoke
 * test: a broken route, a missing scope or a misconfigured origin fails here
 * with the status code and the API's stable error code.
 */
import { createStorage, uniqueKey, StorageError } from './drive-storage.mjs'

const endpoint = process.env.STORAGE_ENDPOINT ?? ''
const apiKey = process.env.STORAGE_API_KEY ?? ''

if (!endpoint || !apiKey) {
  console.error('Set STORAGE_ENDPOINT (…/api/v1) and STORAGE_API_KEY (9d_live_…) first.')
  process.exit(2)
}

const keep = process.argv.includes('--keep')
const prefix = process.env.STORAGE_PREFIX || 'demo-website'

/**
 * A 1x1 PNG. Real image bytes matter here: the preview step is only meaningful
 * if the API has to decide a MIME type and an inline disposition, which is the
 * part that breaks first for a website embedding pictures.
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail })
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${condition || !detail ? '' : `\n         ${detail}`}`)
}

const storage = createStorage({ endpoint, apiKey, prefix })
/**
 * Keys passed *in* are relative to the namespace; the client prefixes
 * `STORAGE_PREFIX` itself. Keys coming *out* of the API (and this is the
 * distinction that bites) are absolute - `put()` returns the stored key, which
 * is what every later call and every URL uses.
 */
const relativeKey = uniqueKey('pixel', 'pixel.png')
let key = ''

async function main() {
  console.log(`9Drive at ${endpoint}`)
  console.log(`namespace "${prefix}", key "${relativeKey}"\n`)

  // ---------------------------------------------------------------- 1. upload
  console.log('1. upload')
  const put = await storage.put(relativeKey, PNG_1X1, { contentType: 'image/png' })
  key = put.key
  check('the server reports the namespaced key', key === `${prefix}/${relativeKey}`, `key=${key}`)
  check('PUT created the object', put.created, `status came back as an update`)
  check('the checksum is an md5 of the bytes sent', /^[0-9a-f]{32}$/.test(put.checksum ?? ''), `checksum=${put.checksum}`)
  check('the ETag is the quoted checksum', put.etag === `"${put.checksum}"`, `etag=${put.etag}`)

  // ------------------------------------------------------------------ 2. list
  console.log('\n2. list / show contents')
  // Listing takes a *relative* prefix too; `objects[].key` comes back absolute.
  const page = await storage.list({ prefix: 'pixel/', maxKeys: 50 })
  const entry = page.objects.find((object) => object.key === key)
  check('the object appears in the listing', Boolean(entry))
  if (!entry) throw new Error('cannot continue without the listing entry')
  check('the listing reports the size', entry.sizeBytes === String(PNG_1X1.length), `sizeBytes=${entry.sizeBytes}`)
  check('the listing reports the mime type', entry.mimeType === 'image/png', `mimeType=${entry.mimeType}`)
  check('the listing carries a preview URL', Boolean(entry.previewUrl), 'no urls.previewUrl - is the server older than this kit?')
  check('the listing carries a download URL', Boolean(entry.downloadUrl))
  check(
    'both URLs are signed, so no key is needed in the browser',
    entry.previewUrl?.includes('sig=') && entry.downloadUrl?.includes('sig='),
  )
  check('the URLs expire', Number.isFinite(Date.parse(entry.expiresAt ?? '')), `expiresAt=${entry.expiresAt}`)

  // --------------------------------------------------------------- 3. preview
  console.log('\n3. preview (no Authorization header)')
  const preview = await fetch(entry.previewUrl)
  check('the preview URL answers 200', preview.status === 200, `status ${preview.status}`)
  check('the content type is the image type', preview.headers.get('content-type')?.startsWith('image/png') === true, preview.headers.get('content-type') ?? '')
  check('it is served inline, not as an attachment', preview.headers.get('x-preview-mode') === 'inline', preview.headers.get('content-disposition') ?? '')
  const previewBytes = Buffer.from(await preview.arrayBuffer())
  check('the bytes are identical to what was uploaded', previewBytes.equals(PNG_1X1), `${previewBytes.length} bytes back`)

  // Video seeking and resumed downloads both depend on this.
  const range = await fetch(entry.previewUrl, { headers: { Range: 'bytes=0-7' } })
  check('a Range request returns 206', range.status === 206, `status ${range.status}`)
  check('the 206 body is the requested slice', (await range.arrayBuffer()).byteLength === 8)
  check('Content-Range is exposed', /^bytes 0-7\//.test(range.headers.get('content-range') ?? ''), range.headers.get('content-range') ?? '')

  // -------------------------------------------------------------- 4. download
  console.log('\n4. download')
  const download = await fetch(entry.downloadUrl)
  check('the download URL answers 200', download.status === 200, `status ${download.status}`)
  check('it is an attachment', download.headers.get('content-disposition')?.startsWith('attachment') === true, download.headers.get('content-disposition') ?? '')
  check('the bytes are identical', Buffer.from(await download.arrayBuffer()).equals(PNG_1X1))

  // A page that cached the old signature must not be able to forge a new one.
  const forged = entry.previewUrl.replace('sig=', 'sig=A')
  if (forged !== entry.previewUrl) {
    const tampered = await fetch(forged)
    check('a tampered signature is refused', tampered.status === 403, `status ${tampered.status}`)
  }

  // ------------------------------------------------------------------ cleanup
  if (!keep) {
    console.log('\ncleanup')
    await storage.remove(relativeKey)
    const after = await storage.get(key)
    check('the object is gone after remove()', after === null)
  }
}

main()
  .then(() => {
    const failed = checks.filter((entry) => !entry.ok)
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
    if (failed.length) process.exit(1)
    if (keep) console.log(`kept: ${key}`)
  })
  .catch((error) => {
    if (error instanceof StorageError) {
      console.error(`\n${error.status} ${error.code}: ${error.message}`)
      if (error.hint) console.error(`hint: ${error.hint}`)
    } else {
      console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    }
    process.exit(1)
  })
