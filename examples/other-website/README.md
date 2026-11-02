# Using 9Drive as the file store for another website

This folder is a copy-paste kit for the *other* project: one environment block,
one small client, and the four calls you actually need.

It replaces the S3/B2 style setup (`B2_KEY_ID`, `B2_APPLICATION_KEY`,
`B2_BUCKET`, `B2_REGION`, `B2_ENDPOINT_URL`). 9Drive sits in front of those
buckets, so the other site needs **two** values and no bucket at all.

## 1. Environment

```env
STORAGE_ENDPOINT=https://drive-edubrixvora-1.onrender.com/api/v1
STORAGE_API_KEY=9d_live_paste_your_key
STORAGE_PREFIX=shop
```

| Variable | What it is |
| --- | --- |
| `STORAGE_ENDPOINT` | Your 9Drive deployment + `/api/v1`. Always ends in `/api/v1`. |
| `STORAGE_API_KEY` | A key from **Storage API** in the 9Drive dashboard. Needs `files:read` + `files:write`, plus `files:delete` if the site removes files. |
| `STORAGE_PREFIX` | Optional. Namespaces this site's objects (`shop/...`). This is what replaces `B2_BUCKET`. |

**Rules that matter**

- Keep `STORAGE_API_KEY` on the server. Never in `NEXT_PUBLIC_*`, never in HTML, never in a mobile bundle.
- Browsers get **signed URLs** (§4) instead.
- Where to paste: Render → Environment; Vercel → Settings → Environment Variables (then Redeploy); Railway/Fly → `variables set` / `secrets set`; a VPS → the project's `.env`, then restart.

## 2. The client

Copy `drive-storage.mjs` into the project (no dependencies, Node 18+):

```js
import { createStorage } from './drive-storage.mjs'

const storage = createStorage() // reads STORAGE_* from the environment
```

Then:

```js
// write (same key again overwrites - never a second copy)
const { etag, created } = await storage.put('products/42.png', buffer, { contentType: 'image/png' })

// read (null when there is no such object)
const file = await storage.get('products/42.png')
if (file) fs.writeFileSync('/tmp/x.png', file.body)

// metadata only
const info = await storage.head('products/42.png')   // { sizeBytes, contentType, etag, lastModified } | null

// delete (idempotent)
await storage.remove('products/42.png')

// list with folder semantics
const page = await storage.list({ prefix: 'products/', delimiter: '/', maxKeys: 100 })

// a link the browser can use
const { url } = await storage.sign('products/42.png', { expiresInSeconds: 3600 })
```

## 3. Wiring it into a framework

### Express (or any Node server)

```js
import express from 'express'
import multer from 'multer'
import { createStorage } from './drive-storage.mjs'

const app = express()
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } })
const storage = createStorage()

app.post('/api/avatar', upload.single('file'), async (req, res) => {
  const key = `avatars/${req.user.id}.png`
  const { etag } = await storage.put(key, req.file.buffer, { contentType: req.file.mimetype })

  // store the key, not the bytes and not a URL: URLs expire
  await db.user.update({ where: { id: req.user.id }, data: { avatarKey: key } })

  const { url } = await storage.sign(key, { expiresInSeconds: 60 * 60 })
  res.json({ key, etag, url })
})

app.delete('/api/avatar', async (req, res) => {
  await storage.remove(`avatars/${req.user.id}.png`)
  res.status(204).end()
})
```

### Next.js (App Router, server side)

```ts
// app/api/upload/route.ts
import { createStorage } from '@/lib/drive-storage'

const storage = createStorage()

export async function POST(request: Request) {
  const form = await request.formData()
  const file = form.get('file') as File
  if (!file) return Response.json({ error: 'file is required' }, { status: 400 })

  const key = `uploads/${crypto.randomUUID()}-${file.name}`
  const meta = await storage.put(key, Buffer.from(await file.arrayBuffer()), { contentType: file.type })
  return Response.json({ key, etag: meta.etag })
}
```

Render an image through a signed redirect instead of exposing the key:

```ts
// app/img/[...key]/route.ts
import { createStorage } from '@/lib/drive-storage'
const storage = createStorage()

export async function GET(_req: Request, { params }: { params: { key: string[] } }) {
  const { url } = await storage.sign(params.key.join('/'), { expiresInSeconds: 300 })
  return Response.redirect(url, 302)
}
```

### No client at all (any language)

```bash
curl -X PUT "$STORAGE_ENDPOINT/objects/shop/hello.txt" \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  -H 'Content-Type: text/plain' \
  --data-binary 'hello'

curl "$STORAGE_ENDPOINT/objects/shop/hello.txt" \
  -H "Authorization: Bearer $STORAGE_API_KEY"
```

## 4. Letting the browser upload or display

Never ship the key. Ask the server for a short-lived link:

```js
// server
const { url } = await storage.sign(`uploads/${userId}/${Date.now()}.png`, {
  method: 'PUT',
  expiresInSeconds: 600,
})
res.json({ uploadUrl: url })
```

```js
// browser
await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: file })
```

For reads, sign with the default `GET` and put it in `src`:

```html
<img src="https://…/api/public/objects/shop/products/42.png?u=…&m=GET&exp=…&sig=…" />
```

A `GET` link cannot be replayed as a `PUT`, cannot be pointed at another key,
and stops working at `exp`.

## 5. Errors

Every failure is JSON with a stable `code`; the client throws `StorageError`
carrying `status`, `code`, `message` and `hint`.

| Status | Code | What to do |
| --- | --- | --- |
| 401 | `API_KEY_REQUIRED` / `API_KEY_INVALID` / `API_KEY_REVOKED` | Wrong or revoked key - create a new one |
| 403 | `API_KEY_SCOPE_MISSING` | Key lacks read/write/delete; the body names the missing scope |
| 404 | `NO_SUCH_KEY` | No object at that key (`get`/`head` return `null` for you) |
| 411 | `OBJECT_SIZE_REQUIRED` | A `PUT` without `Content-Length` - pass a Buffer, not a stream |
| 413 | `OBJECT_TOO_LARGE` | Over the deployment's `MAX_UPLOAD_BYTES` |
| 429 | `RATE_LIMITED` | Slow down; honour `Retry-After` |
| 507 | `NO_ACCOUNT_WITH_ENOUGH_SPACE` | Every connected bucket is full |

## 6. Tests

The client is covered by 13 assertions against a stubbed `fetch` - wire format,
error mapping, prefixing, signed URLs:

```bash
node --test examples/other-website/drive-storage.test.mjs
```

Full API reference: [`docs/API.md`](../../docs/API.md).
