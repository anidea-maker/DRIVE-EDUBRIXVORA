/**
 * A minimal S3-compatible HTTP server for the end-to-end API test.
 *
 * It implements just enough of the S3 wire protocol for the AWS SDK v3 client
 * the backend builds: path-style object PUT/GET/HEAD/DELETE with Range support,
 * HeadBucket and ListObjectsV2 (used by the quota sync). Signatures are not
 * checked - the point is to prove the backend's own upload, verification,
 * download, listing and delete paths really run.
 *
 * This file is test-only. It is never imported by application code.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

function xmlEscape(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char])
}

function errorXml(code, message, status) {
  return { status, body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(message)}</Message></Error>` }
}

/**
 * @param {{ buckets?: string[] }} [options]
 * @returns {Promise<{ url: string, objects: Map<string, { body: Buffer, contentType: string }>, close: () => Promise<void>, failures: { put: boolean } }>}
 */
export function startFakeS3(options = {}) {
  const buckets = new Set(options.buckets ?? ['edvanta-bucket'])
  /** @type {Map<string, { body: Buffer, contentType: string }>} */
  const objects = new Map()
  const failures = { put: false }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.split('/').filter(Boolean)
    const bucket = segments[0] ?? ''
    const key = segments.slice(1).join('/')

    const respond = (status, body = '', headers = {}) => {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
      res.writeHead(status, { 'Content-Length': buffer.length, ...headers })
      res.end(buffer)
    }

    if (bucket && !buckets.has(bucket)) {
      const problem = errorXml('NoSuchBucket', 'The specified bucket does not exist', 404)
      return respond(problem.status, problem.body, { 'Content-Type': 'application/xml' })
    }

    const isList = url.searchParams.get('list-type') === '2' || (segments.length === 1 && req.method === 'GET')

    // ListObjectsV2 - the quota sync sums Content-Length across every object.
    if (isList) {
      const prefix = url.searchParams.get('prefix') ?? ''
      const entries = [...objects.entries()]
        .filter(([name]) => name.startsWith(`${bucket}/${prefix}`))
        .sort(([a], [b]) => a.localeCompare(b))
      const contents = entries
        .map(([name, object]) => {
          const objectKey = name.slice(bucket.length + 1)
          return [
            '<Contents>',
            `<Key>${xmlEscape(objectKey)}</Key>`,
            `<LastModified>${new Date().toUTCString().replace('UTC', 'GMT')}</LastModified>`,
            `<ETag>&quot;${createHash('md5').update(object.body).digest('hex')}&quot;</ETag>`,
            `<Size>${object.body.length}</Size>`,
            '<StorageClass>STANDARD</StorageClass>',
            '</Contents>',
          ].join('')
        })
        .join('')
      return respond(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${entries.length}</KeyCount>` +
          `<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        { 'Content-Type': 'application/xml' },
      )
    }

    // HeadBucket: /{bucket} with no key.
    if (!key) return respond(200)

    if (req.method === 'PUT') {
      // 501 is deliberately not one of the status codes the AWS SDK retries, so a
      // failure test does not spend time on backoff.
      if (failures.put) {
        const problem = errorXml('NotImplemented', 'injected upload failure', 501)
        return respond(problem.status, problem.body, { 'Content-Type': 'application/xml' })
      }
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        objects.set(`${bucket}/${key}`, { body, contentType: req.headers['content-type'] ?? 'application/octet-stream' })
        respond(200, '', { ETag: `"${createHash('md5').update(body).digest('hex')}"` })
      })
      return
    }

    if (req.method === 'DELETE') {
      objects.delete(`${bucket}/${key}`)
      return respond(204)
    }

    const entry = objects.get(`${bucket}/${key}`)
    if (!entry) {
      const problem = errorXml('NoSuchKey', 'The specified key does not exist', 404)
      return respond(problem.status, problem.body, { 'Content-Type': 'application/xml' })
    }

    const etag = `"${createHash('md5').update(entry.body).digest('hex')}"`

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': entry.body.length,
        'Content-Type': entry.contentType,
        ETag: etag,
        'Last-Modified': new Date().toUTCString(),
        'Accept-Ranges': 'bytes',
      })
      return res.end()
    }

    if (req.method === 'GET') {
      const headers = {
        'Content-Type': entry.contentType,
        ETag: etag,
        'Last-Modified': new Date().toUTCString(),
        'Accept-Ranges': 'bytes',
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
      if (range) {
        const start = range[1] ? Number(range[1]) : 0
        const end = range[2] ? Number(range[2]) : entry.body.length - 1
        const slice = entry.body.subarray(start, end + 1)
        // Out-of-range is a 416 in S3, not a silently clamped 200.
        if (start >= entry.body.length || start > end) {
          return respond(416, errorXml('InvalidRange', 'The requested range is not satisfiable', 416).body, {
            'Content-Type': 'application/xml',
            'Content-Range': `bytes */${entry.body.length}`,
          })
        }
        return respond(206, slice, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${entry.body.length}`,
        })
      }
      return respond(200, entry.body, headers)
    }

    return respond(405, errorXml('MethodNotAllowed', 'Unsupported method', 405).body, { 'Content-Type': 'application/xml' })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        objects,
        failures,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}
