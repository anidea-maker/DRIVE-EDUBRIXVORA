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

- Create **one website API key** in 9Drive → API Management with the scopes this site needs. The full key is shown once; only its hash is stored. Rotate it with `POST /api/api-keys/:id/regenerate` (or the dashboard **Rotate** button) if it leaks.
- Send it only as `Authorization: Bearer …`. `?api_key=…` is rejected with `API_KEY_QUERY_NOT_ALLOWED` because URLs are logged and shared.
- Keep `STORAGE_API_KEY` on the server. Never in `NEXT_PUBLIC_*`, never in HTML, never in a mobile bundle.
- Browsers get **signed URLs** (§4) instead. Those links are bound to the live API-key row; revoking the key or removing a scope invalidates outstanding links.
- If browser JavaScript calls 9Drive directly, set `API_CORS_ORIGINS` on 9Drive to this site's exact origin. CORS is not authentication.
- Where to paste: Render → Environment; Vercel → Settings → Environment Variables (then Redeploy); Railway/Fly → `variables set` / `secrets set`; a VPS → the project's `.env`, then restart.

## 2. The client

Copy `drive-storage.mjs` into the project (no dependencies, Node 18+):

```js
import { createStorage, uniqueKey } from './drive-storage.mjs'

const storage = createStorage() // reads STORAGE_* from the environment
```

Then:

```js
// A generated key keeps the display name but does not use it as identity.
// Two different uploads can both be called report.pdf without overwriting.
const key = uniqueKey('products', file.name)
const { etag, checksum, created } = await storage.put(key, buffer, { contentType: file.type })

// read (null when there is no such object)
const file = await storage.get(key)
if (file) fs.writeFileSync('/tmp/x.png', file.body)

// metadata only
const info = await storage.head(key)   // { sizeBytes, contentType, etag, lastModified } | null

// content-based duplicate detection (not filename-based)
const duplicates = await storage.findDuplicates(checksum)

// delete (idempotent)
await storage.remove(key)

// list/search with folder semantics
const page = await storage.list({ prefix: 'products/', delimiter: '/', q: 'biology', mimeType: 'application/pdf', maxKeys: 100 })

// every listed object already carries a browser-ready URL - no second call
for (const object of page.objects) {
  console.log(object.key, object.previewUrl)   // <img src={previewUrl}>
  console.log(object.downloadUrl)              // <a href download>
}

// ...or the same thing shaped for a gallery grid
const tiles = await storage.gallery({ prefix: 'products/', pageSize: 24 })

// a link the browser can use, for a key you already know
const { url, downloadUrl } = await storage.sign(key, { expiresInSeconds: 3600 })
```

`previewUrl` and `downloadUrl` are *signed*, so they go straight into HTML. They
are the same object: `downloadUrl` is `previewUrl` with `download=1`, which makes
the browser save instead of render. Both expire; store the **key**, never the URL.

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
import { createStorage, uniqueKey } from '@/lib/drive-storage'

const storage = createStorage()

export async function POST(request: Request) {
  const form = await request.formData()
  const file = form.get('file') as File
  if (!file) return Response.json({ error: 'file is required' }, { status: 400 })

  const key = uniqueKey('uploads', file.name)
  const meta = await storage.put(key, Buffer.from(await file.arrayBuffer()), { contentType: file.type })
  return Response.json({ key, etag: meta.etag, checksum: meta.checksum })
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

For reads there is nothing extra to build: the listing already returns the
links. Render them directly.

```js
// server: one call, after an upload or when the page loads
const { objects } = await storage.list({ prefix: 'uploads/' })

// template
//   <img src={object.previewUrl} alt="" />
//   <video src={object.previewUrl} controls />          <- Range works, seeking works
//   <a href={object.downloadUrl}>Download</a>
```

```html
<img src="https://…/api/public/objects/shop/products/42.png?u=…&k=api-key%3A…&m=GET&exp=…&sig=…" />
```

`GET /api/v1/objects` and `GET /api/v1/files` both accept `urls=signed|api|none`
and `expiresInSeconds` (30 … 604800, default 3600). `urls=signed` is the default
because it is the one a website needs; pass `urls=none` for a payload you will
not render, or `urls=api` if you would rather proxy the bytes yourself.

A `GET` link cannot be replayed as a `PUT`, cannot be pointed at another key,
and stops working at `exp`. The `k` identity is checked against the live key
row, so a revoked key, an expired key or a removed scope also invalidates it.
PDF, common images, plain text and common audio/video are rendered inline with
`nosniff`; SVG, HTML, JavaScript, Office, archives and unknown types are forced
to `Content-Disposition: attachment`.

## 5. Errors

Every failure is JSON with a stable `code`; the client throws `StorageError`
carrying `status`, `code`, `message` and `hint`.

| Status | Code | What to do |
| --- | --- | --- |
| 401 | `API_KEY_REQUIRED` / `API_KEY_INVALID` / `API_KEY_REVOKED` / `API_KEY_EXPIRED` | Wrong, revoked or expired key - create a new one |
| 401 | `API_KEY_QUERY_NOT_ALLOWED` | The key was sent in `?api_key=`; move it to the Authorization header and rotate it |
| 403 | `API_KEY_SCOPE_MISSING` | Key lacks read/write/delete; the body names the missing scope |
| 403 | `SIGNED_URL_PERMISSION_REVOKED` / `SIGNED_URL_IDENTITY_REQUIRED` | Mint a new signed link after restoring the key or resource |
| 409 | `STORAGE_ACCOUNT_UNAVAILABLE` / `OBJECT_PROVIDER_MIGRATION_UNSUPPORTED` | The recorded account is unavailable/full, or an overwrite tried to change providers. Reconnect the account or use a new key. |
| 404 | `NO_SUCH_KEY` | No object at that key (`get`/`head` return `null` for you) |
| 411 | `OBJECT_SIZE_REQUIRED` | A `PUT` without `Content-Length` - pass a Buffer, not a stream |
| 413 | `OBJECT_TOO_LARGE` | Over the deployment's `MAX_UPLOAD_BYTES` |
| 429 | `RATE_LIMITED` | Slow down; honour `Retry-After` |
| 507 | `NO_ACCOUNT_WITH_ENOUGH_SPACE` | Every connected bucket is full |

## 6. 9Drive deployment checklist

These changes stay entirely inside the existing 9Drive service. No new platform
bucket, no provider credential on this website, no new project.

1. Apply the committed additive migration `20261102140000_website_api_hardening`
   with `npm run db:migrate:deploy` (Render start command already does this).
   It changes the default role for **new** users to `visitor` and creates the
   optional shared rate-limit table. Existing rows are not rewritten.
2. Create one API key with `files:read`, `files:write` and (if needed)
   `files:delete`. Paste only the key into this website's server environment.
3. Set `API_CORS_ORIGINS` to this website's exact origin if browser JavaScript
   calls 9Drive directly. Leave it empty for server-to-server calls.
4. Set `API_RATE_LIMIT_STORAGE=database` only when 9Drive runs on multiple
   instances; the default `memory` limiter is enough for one Render service.
5. Keep `REQUEST_TIMEOUT_MS` long enough for `MAX_UPLOAD_BYTES` (default
   30 minutes for 5 GiB). Provider errors are returned as stable codes, never
   raw bucket names, endpoints, emails or tokens.

New 9Drive accounts are `visitor`. Promote the account that owns the connected
storage through `SUPER_ADMIN_EMAILS` or
`PATCH /api/admin/users/:id/role` before creating the website key.

## 7. Tests

The client is covered by **16/16** mocked assertions against a stubbed `fetch` -
wire format, error mapping, prefixing, unique keys, checksum search, signed URLs
and the gallery/URL flattening:

```bash
node --test examples/other-website/drive-storage.test.mjs
```

There is also an **end-to-end walkthrough** that does the whole thing against a
real deployment - upload, list, preview (including a Range request) and download -
and prints the URLs it used:

```bash
STORAGE_ENDPOINT=https://your-9drive.onrender.com/api/v1 \
STORAGE_API_KEY=9d_live_… \
node examples/other-website/demo.mjs
```

It exits non-zero on the first mismatch, so it doubles as a smoke test after a
9Drive deploy. Nothing is left behind: the objects it writes are deleted at the
end unless you pass `--keep`.

Full API reference: [`docs/API.md`](../../docs/API.md). Requirement-by-requirement
audit: [`docs/WEBSITE-API-AUDIT.md`](../../docs/WEBSITE-API-AUDIT.md).
