/**
 * End-to-end smoke test for the public storage API.
 *
 * Creates a throwaway key for the first user, then walks the whole lifecycle a
 * client website would: upload → list → read bytes → share → delete. Every step
 * asserts, because the previous version of this script only checked that the
 * upload returned 200 and left the read path (the part that was missing) untested.
 *
 *   cd backend && npm run test:api        # against http://localhost:4000
 *   API_URL=https://… npm run test:api
 */
import { prisma } from '../config/prisma.js'
import { deleteS3Object } from '../modules/s3/s3.service.js'
import { hashToken, randomToken } from '../utils/crypto.js'
import { toJsonArrayColumn } from '../utils/json-column.js'

const apiUrl = (process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, '')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function json<T>(response: Response, step: string): Promise<T> {
  const text = await response.text()
  if (!response.ok) throw new Error(`${step} failed: ${response.status} ${text}`)
  return JSON.parse(text) as T
}

async function main() {
  const user = await prisma.user.findFirst({ select: { id: true } })
  if (!user) throw new Error('No user found. Register a user first.')

  const secret = `9d_live_${randomToken(32)}`
  const apiKey = await prisma.apiKey.create({
    data: {
      userId: user.id,
      name: 'API storage smoke test',
      keyPrefix: secret.slice(0, 16),
      keyHash: hashToken(secret),
      scopes: toJsonArrayColumn(['files:read', 'files:write', 'files:delete']),
    },
  })
  const auth = { Authorization: `Bearer ${secret}` }
  const content = `api storage smoke test ${new Date().toISOString()}`
  const created: string[] = []

  try {
    /* --------------------------------------------------------------- upload */
    const form = new FormData()
    form.append('filesMeta', JSON.stringify([{ fieldName: 'file-0', fileName: 'api-smoke.txt', mimeType: 'text/plain', sizeBytes: String(Buffer.byteLength(content)) }]))
    form.append('file-0', new Blob([content], { type: 'text/plain' }), 'api-smoke.txt')

    const upload = await json<{ files: Array<{ id: string; urls: { content: string } }> }>(
      await fetch(`${apiUrl}/api/v1/files`, { method: 'POST', headers: auth, body: form }),
      'multipart upload',
    )
    const fileId = upload.files?.[0]?.id
    assert(fileId, 'multipart upload returned no files')
    assert(upload.files[0]?.urls?.content, 'upload response has no content URL - withApiFileShape did not run')
    created.push(fileId)
    console.log('upload            ok', fileId)

    /* ----------------------------------------------------------------- list */
    const list = await json<{ files: Array<{ id: string; sizeBytes: string }> }>(
      await fetch(`${apiUrl}/api/v1/files?limit=5&q=api-smoke`, { headers: auth }),
      'list',
    )
    assert(list.files.some((file) => file.id === fileId), 'uploaded file is missing from the list')
    assert(typeof list.files[0]?.sizeBytes === 'string', 'sizeBytes must be a string')
    console.log('list              ok', list.files.length, 'files')

    /* --------------------------------------------------------------- read it */
    const bytes = await fetch(`${apiUrl}/api/v1/files/${fileId}/content`, { headers: auth })
    assert(bytes.ok, `content read failed: ${bytes.status}`)
    assert((await bytes.text()) === content, 'downloaded bytes differ from what was uploaded')
    console.log('download          ok')

    /* ----------------------------------------------------------- public URL */
    const share = await json<{ url: string }>(
      await fetch(`${apiUrl}/api/v1/files/${fileId}/share`, { method: 'POST', headers: auth }),
      'share',
    )
    const publicBytes = await fetch(share.url)
    assert(publicBytes.ok, `share URL failed without a key: ${publicBytes.status}`)
    assert((await publicBytes.text()) === content, 'share URL returned different bytes')
    console.log('share url         ok', share.url)

    /* ------------------------------------------------------------- metadata */
    const one = await json<{ file: { id: string }; share: unknown }>(
      await fetch(`${apiUrl}/api/v1/files/${fileId}`, { headers: auth }),
      'metadata',
    )
    assert(one.file.id === fileId, 'metadata returned the wrong file')
    assert(one.share, 'metadata did not report the share that was just minted')
    console.log('metadata          ok')

    /* --------------------------------------------------------------- delete */
    await json(await fetch(`${apiUrl}/api/v1/files/${fileId}?permanent=1`, { method: 'DELETE', headers: auth }), 'delete')
    created.length = 0
    console.log('delete            ok')

    /* ------------------------------------------------- object: write/read */
    const objectKey = `api-smoke/${Date.now()}.txt`
    const objectUrl = `${apiUrl}/api/v1/objects/${objectKey}`
    const putHeaders = { ...auth, 'Content-Type': 'text/plain' }

    const putFirst = await fetch(objectUrl, { method: 'PUT', headers: putHeaders, body: 'hello object' })
    assert(putFirst.status === 201, `first PUT should be 201, got ${putFirst.status} ${await putFirst.clone().text()}`)
    const etag = putFirst.headers.get('etag')
    assert(etag?.startsWith('"') && etag.endsWith('"'), `PUT should return a quoted ETag, got ${etag}`)
    console.log('object put        ok', etag)

    const readFirst = await fetch(objectUrl, { headers: auth })
    assert(readFirst.ok, `GET object failed: ${readFirst.status}`)
    assert((await readFirst.text()) === 'hello object', 'object bytes differ from what was written')
    console.log('object get        ok')

    const head = await fetch(objectUrl, { method: 'HEAD', headers: auth })
    assert(head.status === 200, `HEAD should be 200, got ${head.status}`)
    assert(head.headers.get('etag') === etag, 'HEAD ETag differs from PUT ETag')
    assert(head.headers.get('content-length') === '12', `HEAD content-length wrong: ${head.headers.get('content-length')}`)
    assert(head.headers.get('last-modified'), 'HEAD should send Last-Modified')
    console.log('object head       ok')

    /* ------------------------------------------------------ object overwrite */
    const putSecond = await fetch(objectUrl, { method: 'PUT', headers: putHeaders, body: 'replaced!' })
    assert(putSecond.status === 200, `overwrite should be 200, got ${putSecond.status}`)
    assert((await (await fetch(objectUrl, { headers: auth })).text()) === 'replaced!', 'overwrite did not replace the bytes')
    console.log('object overwrite  ok')

    /* --------------------------------------------------------- object listing */
    const listing = await json<{ objects: Array<{ key: string; checksum: string | null }>; isTruncated: boolean }>(
      await fetch(`${apiUrl}/api/v1/objects?prefix=api-smoke/`, { headers: auth }),
      'object list',
    )
    assert(listing.objects.some((object) => object.key === objectKey), 'the object is missing from the listing')
    console.log('object list       ok', listing.objects.length, 'objects')

    const checksum = listing.objects.find((object) => object.key === objectKey)?.checksum
    assert(checksum, 'object listing did not return a checksum')
    const duplicates = await json<{ objects: Array<{ key: string }> }>(
      await fetch(`${apiUrl}/api/v1/objects?checksum=${encodeURIComponent(checksum)}`, { headers: auth }),
      'checksum duplicate lookup',
    )
    assert(duplicates.objects.some((object) => object.key === objectKey), 'checksum lookup missed the uploaded object')
    console.log('checksum lookup   ok', checksum)

    /* ---------------------------------------------------------- signed links */
    const signed = await json<{ url: string }>(
      await fetch(`${apiUrl}/api/v1/objects/sign`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: objectKey, method: 'GET', expiresInSeconds: 120 }),
      }),
      'sign',
    )
    const unsigned = await fetch(signed.url)
    assert(unsigned.ok, `signed GET failed without a key: ${unsigned.status}`)
    assert((await unsigned.text()) === 'replaced!', 'signed GET returned different bytes')
    const signedIdentity = new URL(signed.url).searchParams.get('k')
    assert(signedIdentity?.startsWith('api-key:'), `signed URL is missing its live key identity, got ${signedIdentity}`)
    console.log('object sign       ok', signedIdentity)

    const tampered = await fetch(signed.url.replace(/sig=[^&]+/, 'sig=deadbeef'))
    assert(tampered.status === 403, `a bad signature should be 403, got ${tampered.status}`)
    const unsignedNoQuery = await fetch(signed.url.split('?')[0]!)
    assert(unsignedNoQuery.status === 401, `an unsigned request should be 401, got ${unsignedNoQuery.status}`)

    // Revoking the key that minted the link must invalidate it immediately.
    await prisma.apiKey.update({ where: { id: apiKey.id }, data: { status: 'revoked', revokedAt: new Date() } })
    const revokedLink = await fetch(signed.url)
    assert(revokedLink.status === 403, `a link from a revoked key should be 403, got ${revokedLink.status}`)
    await prisma.apiKey.update({ where: { id: apiKey.id }, data: { status: 'active', revokedAt: null } })
    console.log('signature refusal ok')

    /* --------------------------------------------------------- object delete */
    const deleted = await fetch(objectUrl, { method: 'DELETE', headers: auth })
    assert(deleted.status === 204, `DELETE should be 204, got ${deleted.status}`)
    const gone = await fetch(objectUrl, { headers: auth })
    assert(gone.status === 404, `GET after DELETE should be 404, got ${gone.status}`)
    const deletedAgain = await fetch(objectUrl, { method: 'DELETE', headers: auth })
    assert(deletedAgain.status === 204, `DELETE is idempotent, got ${deletedAgain.status}`)
    console.log('object delete     ok')

    /* -------------------------------------------------------------- scopes */
    const forbidden = await fetch(`${apiUrl}/api/v1/files`, { headers: { Authorization: 'Bearer 9d_live_not_a_key' } })
    assert(forbidden.status === 401, `a bogus key should be 401, got ${forbidden.status}`)
    const queryKey = await fetch(`${apiUrl}/api/v1/files?api_key=ignored`, { headers: auth })
    assert(queryKey.status === 401, `a query-string key should be rejected, got ${queryKey.status}`)
    const queryKeyBody = await queryKey.json() as { code?: string }
    assert(queryKeyBody.code === 'API_KEY_QUERY_NOT_ALLOWED', `expected API_KEY_QUERY_NOT_ALLOWED, got ${queryKeyBody.code}`)
    console.log('auth rejection    ok')
  } finally {
    for (const id of created) {
      const file = await prisma.file.findUnique({ where: { id }, include: { connectedAccount: true } })
      if (!file) continue
      if (file.provider === 's3') await deleteS3Object(file).catch(() => undefined)
      await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
    }
    await prisma.apiKey.update({ where: { id: apiKey.id }, data: { status: 'revoked', revokedAt: new Date() } })
  }

  console.log('\nAll storage API checks passed.')
}

main().catch((error) => {
  console.error('\n' + (error instanceof Error ? error.message : 'API test failed'))
  process.exit(1)
}).finally(async () => {
  await prisma.$disconnect()
})
