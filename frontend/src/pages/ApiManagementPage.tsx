import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { AlertTriangle, Check, Code2, Copy, Globe, Image as ImageIcon, KeyRound, Layers, Plus, RefreshCw, Server, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { PageHeader } from '@/components/drive/PageHeader'
import { API_URL, apiFetch, formatDate } from '@/lib/api'

type ApiKey = {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  status: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

type ScopeInfo = { id: string; label: string; description: string; grants: string[] }

/**
 * The docs must show the URL that actually answers. `API_URL` is `/api` in the
 * same-origin deployment, and the previous examples interpolated it as
 * `${API_URL}/api/v1/...`, which documented `/api/api/v1/...` - a 404 that looked
 * like a broken API.
 */
function useApiBase() {
  const base = `${API_URL.replace(/\/+$/, '')}/v1`
  return useMemo(() => {
    // `API_URL` is `/api` in the same-origin deployment, but a build can point it
    // at a separate API origin. Concatenating the page origin in front of an
    // absolute URL produced "https://app...https://api..." in the old docs.
    const absolute = /^https?:\/\//i.test(base)
      ? base
      : `${typeof window === 'undefined' ? '' : window.location.origin}${base}`
    return { path: base, absolute }
  }, [base])
}

function CopyButton({ value, label = 'Copy', onCopied }: { value: string; label?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            onCopied?.()
            window.setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => setCopied(false))
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[13px] font-bold">{label}</p>
        <CopyButton value={code} />
      </div>
      <pre className="max-h-80 max-w-full overflow-auto rounded-2xl border border-[var(--border)] bg-[#0b1020] p-4 text-[12.5px] leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function ScopeChip({ scope }: { scope: string }) {
  const legacy = scope === 'files:upload'
  return (
    <span
      className={
        legacy
          ? 'rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-800'
          : 'rounded-full border border-[var(--border)] bg-[var(--surface-inset)] px-2.5 py-1 text-[11px] font-bold text-slate-600'
      }
    >
      {legacy ? 'files:upload (legacy)' : scope}
    </span>
  )
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[11px] font-extrabold text-[var(--accent-strong)]">{index}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-bold">{title}</p>
        <div className="mt-1 text-[13px] leading-relaxed text-slate-500">{children}</div>
      </div>
    </div>
  )
}

export function ApiManagementPage() {
  const base = useApiBase()
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [scopes, setScopes] = useState<ScopeInfo[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [chosenScopes, setChosenScopes] = useState<string[]>([])
  const [secret, setSecret] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  /**
   * Whether the Base URL shown above actually reaches this deployment's API.
   *
   * The page tells a website where to send its requests, so a wrong value is
   * copied out of the UI and fails on the other project - the worst place to
   * discover it. `GET <base>` answers JSON with a `service` field when the base
   * is right, and a 404 when a static host or SPA is answering instead.
   */
  const [baseCheck, setBaseCheck] = useState<'checking' | 'ok' | 'failed'>('checking')

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    fetch(base.absolute, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then(async (response) => {
        if (cancelled) return
        if (!response.ok) {
          setBaseCheck('failed')
          return
        }
        const data = (await response.json().catch(() => null)) as { service?: string } | null
        setBaseCheck(data?.service ? 'ok' : 'failed')
      })
      .catch(() => {
        if (!cancelled) setBaseCheck('failed')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [base.absolute])

  async function load() {
    const data = await apiFetch<{ apiKeys: ApiKey[] }>('/api-keys')
    setApiKeys(data.apiKeys)
  }

  useEffect(() => {
    load().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to load API keys'))
    apiFetch<{ scopes: ScopeInfo[]; defaultScopes: string[] }>('/api-keys/scopes')
      .then((data) => {
        setScopes(data.scopes)
        setChosenScopes(data.defaultScopes)
      })
      .catch(() => {
        // The catalogue endpoint is a nicety; a hardcoded set keeps the form usable.
        const fallback = ['files:read', 'files:write', 'files:delete']
        setChosenScopes(fallback)
        setScopes(fallback.map((id) => ({ id, label: id, description: '', grants: [] })))
      })
  }, [])

  async function createKey(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setMessage('')
    try {
      const data = await apiFetch<{ apiKey: ApiKey; secret: string }>('/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: keyName, scopes: chosenScopes }),
      })
      setSecret(data.secret)
      setKeyName('')
      setCreateOpen(false)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to create API key')
    } finally {
      setLoading(false)
    }
  }

  async function revokeKey(id: string) {
    await apiFetch(`/api-keys/${id}`, { method: 'DELETE' })
    await load()
  }

  async function regenerateKey(id: string) {
    setLoading(true)
    setMessage('')
    try {
      const data = await apiFetch<{ apiKey: ApiKey; secret: string }>(`/api-keys/${id}/regenerate`, { method: 'POST' })
      setSecret(data.secret)
      setMessage('The previous key was revoked. Copy the new key now and update the website environment.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to regenerate API key')
    } finally {
      setLoading(false)
    }
  }

  function toggleScope(id: string) {
    setChosenScopes((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  const activeKeys = apiKeys.filter((apiKey) => apiKey.status === 'active')
  const legacyKeys = activeKeys.filter((apiKey) => !apiKey.scopes.some((scope) => scope !== 'files:upload'))

  const uploadExample = `// Server-side upload from your other website
const res = await fetch('${base.absolute}/files', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\` },
  body: (() => {
    const form = new FormData()
    form.append('filesMeta', JSON.stringify([{
      fieldName: 'file-0',
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: String(file.size),
    }]))
    form.append('file-0', file)
    return form
  })(),
})

const { file } = await res.json()
// file.id, file.name, file.sizeBytes, file.urls.content
await db.save({ storageKey: file.id, name: file.name })`

  const rawExample = `# One file, straight from the body - no multipart needed
curl -X POST '${base.absolute}/files/raw?name=hero.jpg' \\
  -H "Authorization: Bearer $DRIVE_API_KEY" \\
  -H 'Content-Type: image/jpeg' \\
  --data-binary @hero.jpg`

  const readExample = `// List, then fetch one file's bytes
const list = await fetch('${base.absolute}/files?limit=20&kind=image', {
  headers: { Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\` },
}).then((r) => r.json())

const one = await fetch(\`${base.absolute}/files/\${list.files[0].id}/content\`, {
  headers: { Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\` },
}).then((r) => r.arrayBuffer())`

  const imageExample = `// A public URL needs no key, so it can go straight into your HTML.
// Mint one once per file and store it next to the file id.
const share = await fetch(\`${base.absolute}/files/\${fileId}/share\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\` },
}).then((r) => r.json())

// share.url          -> https://…/api/public/files/<token>/preview
// share.downloadUrl  -> …/download (Content-Disposition: attachment)
await db.save({ storageKey: fileId, publicUrl: share.url })

// Then in your templates:
// <img src={publicUrl} alt="" />
// <video src={publicUrl} controls />
// <a href={downloadUrl}>Download</a>`

  const objectVerbs = [
    { verb: 'PUT', path: '/objects/<key>', behaviour: 'Write the body. 201 created, 200 overwritten.' },
    { verb: 'GET', path: '/objects/<key>', behaviour: 'Bytes, with Range and If-None-Match (304).' },
    { verb: 'HEAD', path: '/objects/<key>', behaviour: 'Content-Type, Content-Length, ETag, Last-Modified only.' },
    { verb: 'DELETE', path: '/objects/<key>', behaviour: 'Delete for good. Always 204.' },
    { verb: 'GET', path: '/objects?prefix=&delimiter=', behaviour: 'List; delimiter=/ collapses the rest into folders.' },
    { verb: 'POST', path: '/objects/sign', behaviour: 'Expiring URL for GET or PUT, for browsers.' },
  ] as const

  const objectExample = `// The body is the object - no multipart, no second copy
await fetch('${base.absolute}/objects/branding/logo.png', {
  method: 'PUT',
  headers: {
    Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\`,
    'Content-Type': 'image/png',
  },
  body: pngBuffer,          // Buffer, Blob or a read stream
})

const res = await fetch('${base.absolute}/objects/branding/logo.png', {
  headers: { Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\` },
})
const bytes = Buffer.from(await res.arrayBuffer())
// res.headers.get('etag')           -> "9b2cf5..."
// res.headers.get('last-modified')`

  const objectListExample = `# Write straight from a file
curl -X PUT "${base.absolute}/objects/branding/logo.png" \\
  -H "Authorization: Bearer $DRIVE_API_KEY" \\
  -H "Content-Type: image/png" \\
  --upload-file ./logo.png

# List one "folder" - delimiter collapses the rest
curl "${base.absolute}/objects?prefix=branding/&delimiter=/" \\
  -H "Authorization: Bearer $DRIVE_API_KEY"`

  const objectUrlExample = `// The browser never sees the key: sign a short-lived link.
const { url } = await fetch('${base.absolute}/objects/sign', {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.DRIVE_API_KEY}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ key: 'branding/logo.png', method: 'GET', expiresInSeconds: 3600 }),
}).then((r) => r.json())

// <img src={url} />

// ...and a PUT link so a browser uploads directly to storage:
// { key: 'uploads/user-' + id + '.png', method: 'PUT', expiresInSeconds: 600 }`

  const endpoints = [
    { method: 'GET', path: '/files', scope: 'files:read', text: 'List files. Query: limit, cursor, folderId, root=1, q, kind, order.' },
    { method: 'POST', path: '/files', scope: 'files:write', text: 'Multipart upload. Returns the stored file with URLs.' },
    { method: 'POST', path: '/files/raw', scope: 'files:write', text: 'Body is the file itself. Query: name, type, folderId.' },
    { method: 'GET', path: '/files/:id', scope: 'files:read', text: 'One file, its URLs, and its current share link.' },
    { method: 'GET', path: '/files/:id/content', scope: 'files:read', text: 'Bytes. Supports Range, so video seeking works.' },
    { method: 'PATCH', path: '/files/:id', scope: 'files:write', text: 'Rename or move: name, folderId.' },
    { method: 'DELETE', path: '/files/:id', scope: 'files:delete', text: 'Move to trash. permanent=1 deletes from the provider.' },
    { method: 'POST', path: '/files/:id/share', scope: 'files:write', text: 'Public URL that needs no key. expiresInSeconds optional.' },
    { method: 'DELETE', path: '/files/:id/share', scope: 'files:write', text: 'Revoke every public URL for the file.' },
    { method: 'GET', path: '/folders', scope: 'files:read', text: 'Folders. Query: parentId, or all=1 for a flat list.' },
    { method: 'POST', path: '/folders', scope: 'files:write', text: 'Create a folder: name, parentId.' },
    // `GET /api/v1/usage` is the real path; `/usage` alone 404s, and a docs table
    // that lists a 404 costs more trust than it saves vertical space.
    { method: 'GET', path: '/usage', scope: 'files:read', text: 'Used and available bytes across all accounts.' },
    { method: 'GET', path: '/me', scope: 'files:read', text: 'Which user and key this is, plus per-account storage.' },
  ] as const

  return (
    <>
      <PageHeader
        title="Storage API"
        description="Use 9Drive as the storage behind another website: put files in, read them out, and serve them without exposing a key."
        actions={
          <>
            <CopyButton value={base.absolute} label="Copy base URL" />
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create key
            </Button>
          </>
        }
      />

      {message ? <p className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-inset)] p-3 text-[13px] text-slate-600">{message}</p> : null}

      {secret ? (
        <Card className="mt-5 min-w-0 overflow-hidden border-[var(--accent-border)] p-0">
          <div className="grid min-w-0 gap-4 p-4 sm:p-5">
            <div className="flex min-w-0 items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent)] text-white">
                <KeyRound className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-[15px] font-extrabold">Copy this key now</p>
                <p className="mt-1 text-[13px] text-slate-500">It is stored hashed, so it cannot be shown again. Put it in the other site&apos;s environment variables, never in its HTML.</p>
              </div>
            </div>
            <div className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              <code className="block min-w-0 max-w-full overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-inset)] p-3 text-xs font-semibold text-slate-900 sm:text-[13px]">{secret}</code>
              <CopyButton value={secret} label="Copy key" />
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setSecret('')}>I saved it</Button>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <KeyRound className="h-5 w-5 text-[var(--accent)]" />
          <p className="tabular mt-3 text-2xl font-extrabold">{activeKeys.length}</p>
          <p className="text-[13px] text-slate-500">Active keys</p>
        </Card>
        <Card className="p-4">
          <Server className="h-5 w-5 text-[var(--accent)]" />
          <p className="mt-3 truncate text-[15px] font-extrabold">{base.absolute.replace(/^https?:\/\//, '')}</p>
          <p className="text-[13px] text-slate-500">
            Base URL{' '}
            {baseCheck === 'ok' ? (
              <span className="font-semibold text-emerald-600">- reachable</span>
            ) : baseCheck === 'failed' ? (
              <span className="font-semibold text-red-600">- not answering as an API</span>
            ) : null}
          </p>
          {baseCheck === 'failed' ? (
            <p className="mt-2 text-[12px] leading-relaxed text-red-600">
              This URL did not answer with the storage API. Copying it into another website would produce 404s there.
              Check <code className="rounded bg-[var(--surface-inset)] px-1">VITE_API_URL</code> at build time and{' '}
              <code className="rounded bg-[var(--surface-inset)] px-1">API_UPSTREAM</code> on this service, then reload.
            </p>
          ) : null}
        </Card>
        <Card className="p-4">
          <Globe className="h-5 w-5 text-[var(--accent)]" />
          <p className="mt-3 text-2xl font-extrabold">Any</p>
          <p className="text-[13px] text-slate-500">Origin allowed (key-authenticated)</p>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="min-w-0 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <Code2 className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[17px] font-extrabold">Connect another website</h2>
          </div>
          <div className="mt-4 grid gap-4">
            <Step index={1} title="Create a key with Read + Write (and Delete if the site should remove files)">
              The secret appears once. Keep it on that site&apos;s server, in something like <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">DRIVE_API_KEY</code>.
            </Step>
            <Step index={2} title="Point it at this base URL">
              <code className="break-all rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">{base.absolute}</code>
            </Step>
            <Step index={3} title="Upload and keep the returned file id">
              Sizes are strings on purpose - these values can exceed what a JavaScript number holds exactly.
            </Step>
            <Step index={4} title="Serve it with a share URL">
              Your visitors&apos; browsers must never see the key. <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">POST /files/:id/share</code> returns a URL that needs no key.
            </Step>
          </div>

          <div className="mt-5 grid gap-5">
            <CodeBlock label="Upload (Node, server side)" code={uploadExample} />
            <CodeBlock label="Upload raw bytes (curl)" code={rawExample} />
          </div>
        </Card>

        <Card className="min-w-0 p-4 sm:p-5">
          <div className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[17px] font-extrabold">Read it back</h2>
          </div>
          <p className="mt-1 text-[13px] text-slate-500">
            Everything here doubles as a plain CDN-style host: Range requests work, so <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">&lt;video&gt;</code> seeking and resumable downloads behave.
          </p>
          <div className="mt-4 grid gap-5">
            <CodeBlock label="List and download" code={readExample} />
            <CodeBlock label="Public URL for <img> / <video>" code={imageExample} />
          </div>
          <div className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--surface-inset)] p-4">
            <p className="text-[13px] font-bold">Good to know</p>
            <ul className="mt-2 grid gap-1.5 text-[13px] leading-relaxed text-slate-500">
              <li>Keys work from any origin - they are bearer tokens, so a browser never sends one by itself.</li>
              <li>Uploads are routed to whichever connected account has room, unless you pin a folder.</li>
              <li><code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">?api_key=</code> works when a client cannot set headers. Prefer share URLs for browsers.</li>
              <li>Rate limit: 600 requests per minute per key.</li>
            </ul>
          </div>
        </Card>
      </div>

      <Card className="mt-6 min-w-0 p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-[var(--accent)]" />
          <h2 className="text-[17px] font-extrabold">Objects (S3-style)</h2>
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-slate-500">
          The same storage addressed by path instead of id. <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">PUT</code> to a key writes that object, and the same key again replaces it - there is never a second copy. It is a normal <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">fetch</code>, so keep putting files in.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="pb-2 pr-3 font-bold">Verb</th>
                <th className="pb-2 pr-3 font-bold">Path</th>
                <th className="pb-2 font-bold">Behaviour</th>
              </tr>
            </thead>
            <tbody>
              {objectVerbs.map((row) => (
                <tr key={`${row.verb} ${row.path}`} className="border-t border-[var(--border)] align-top">
                  <td className="py-2.5 pr-3"><span className="rounded-md bg-[var(--surface-inset)] px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-600">{row.verb}</span></td>
                  <td className="py-2.5 pr-3 font-mono text-[12px] font-semibold">{row.path}</td>
                  <td className="py-2.5 text-slate-500">{row.behaviour}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <CodeBlock label="Write and read an object (Node)" code={objectExample} />
          <CodeBlock label="curl: upload a file, list by prefix" code={objectListExample} />
          <CodeBlock label="Signed URLs for the browser" code={objectUrlExample} />
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-inset)] p-4">
            <p className="text-[13px] font-bold">Object rules</p>
            <ul className="mt-2 grid gap-1.5 text-[13px] leading-relaxed text-slate-500">
              <li>Keys are paths: <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">branding/logo.png</code>. No leading or trailing slash, no <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">..</code>, up to 700 characters.</li>
              <li>Every write returns an <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">ETag</code> (MD5), so conditional <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">If-None-Match</code> works.</li>
              <li><code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">DELETE</code> always answers <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">204</code> - deleting a key that is gone is success.</li>
              <li>Missing key on <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">GET</code>/<code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">HEAD</code> is <code className="rounded bg-[var(--surface)] px-1 py-0.5 text-[12px]">404 NO_SUCH_KEY</code>.</li>
              <li>Objects appear in the dashboard with their key, and dashboard uploads appear in listings.</li>
            </ul>
          </div>
        </div>
      </Card>

      <Card className="mt-6 min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[17px] font-extrabold">API keys</h2>
          <p className="text-[12px] text-slate-500">Secrets are never stored in readable form.</p>
        </div>

        {legacyKeys.length > 0 ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {legacyKeys.length === 1 ? 'One key was' : `${legacyKeys.length} keys were`} created before read and delete existed, so {legacyKeys.length === 1 ? 'it' : 'they'} can only upload. Create a new key to read files back.
            </p>
          </div>
        ) : null}

        <div className="mt-4 grid gap-3">
          {apiKeys.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] p-6 text-center">
              <KeyRound className="mx-auto h-8 w-8 text-[var(--accent)]" />
              <p className="mt-3 font-extrabold">No keys yet</p>
              <p className="mt-1 text-[13px] text-slate-500">Create one key, copy it once, then wire it into the other site.</p>
              <Button className="mt-4 w-full sm:w-auto" onClick={() => setCreateOpen(true)}>Create key</Button>
            </div>
          ) : (
            apiKeys.map((apiKey) => (
              <div key={apiKey.id} className="grid min-w-0 gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words text-[14px] font-bold">{apiKey.name}</p>
                    <span
                      className={
                        apiKey.status === 'active'
                          ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700'
                          : 'rounded-full bg-[var(--surface-inset)] px-2 py-0.5 text-[11px] font-bold text-slate-500'
                      }
                    >
                      {apiKey.status}
                    </span>
                    {apiKey.scopes.map((scope) => <ScopeChip key={scope} scope={scope} />)}
                  </div>
                  <div className="mt-2 grid min-w-0 gap-1 text-[12.5px] text-slate-500 sm:grid-cols-2">
                    <p className="min-w-0 truncate"><span className="font-semibold text-slate-700">Prefix:</span> {apiKey.keyPrefix}…</p>
                    <p className="min-w-0 break-words"><span className="font-semibold text-slate-700">Last used:</span> {apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : 'Never'}</p>
                    <p className="min-w-0 break-words"><span className="font-semibold text-slate-700">Created:</span> {formatDate(apiKey.createdAt)}</p>
                    {apiKey.expiresAt ? <p className="min-w-0 break-words"><span className="font-semibold text-slate-700">Expires:</span> {formatDate(apiKey.expiresAt)}</p> : null}
                  </div>
                </div>
                <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                  <Button className="w-full sm:w-auto" variant="outline" onClick={() => regenerateKey(apiKey.id)} disabled={loading || apiKey.status !== 'active'}>
                    <RefreshCw className="h-4 w-4" />
                    Rotate
                  </Button>
                  <Button className="w-full sm:w-auto" variant="danger" onClick={() => revokeKey(apiKey.id)} disabled={loading || apiKey.status !== 'active'}>
                    <Trash2 className="h-4 w-4" />
                    Revoke
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="mt-6 min-w-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[17px] font-extrabold">Endpoints</h2>
          <CopyButton value={`${base.absolute}`} label="Copy base URL" />
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                <th className="pb-2 pr-3 font-bold">Method</th>
                <th className="pb-2 pr-3 font-bold">Path</th>
                <th className="pb-2 pr-3 font-bold">Scope</th>
                <th className="pb-2 font-bold">What it does</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={`${endpoint.method}-${endpoint.path}`} className="border-t border-[var(--border)] align-top">
                  <td className="py-2.5 pr-3">
                    <span className="rounded-md bg-[var(--surface-inset)] px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-600">{endpoint.method}</span>
                  </td>
                  <td className="py-2.5 pr-3 font-mono text-[12px] font-semibold">{endpoint.path}</td>
                  <td className="py-2.5 pr-3 text-[12px] text-slate-500">{endpoint.scope}</td>
                  <td className="py-2.5 text-slate-500">{endpoint.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-[12.5px] text-slate-500">
          <code className="rounded bg-[var(--surface-inset)] px-1 py-0.5 text-[12px]">{`${base.absolute}`}</code> returns this information as JSON, including the scopes and limits this deployment enforces.
        </p>
      </Card>

      <DummyModal
        open={createOpen}
        title="Create API key"
        description="Choose what the other website may do. You can give it read-only access and still serve files through public share links."
        onClose={() => setCreateOpen(false)}
      >
        <form className="grid gap-4" onSubmit={createKey}>
          <label className="grid gap-1.5">
            <span className="text-[12px] font-bold uppercase tracking-wide text-slate-400">Name</span>
            <input
              className="h-11 rounded-xl border border-[var(--border)] bg-[var(--input-bg)] px-3 text-sm"
              placeholder="e.g. shop.example.com"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              required
            />
          </label>

          <div className="grid gap-2">
            <span className="text-[12px] font-bold uppercase tracking-wide text-slate-400">Scopes</span>
            {scopes.map((scope) => {
              const checked = chosenScopes.includes(scope.id)
              return (
                <label
                  key={scope.id}
                  className={
                    checked
                      ? 'flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] p-3'
                      : 'flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3'
                  }
                >
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={checked} onChange={() => toggleScope(scope.id)} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold">{scope.label} <span className="font-mono text-[11px] font-medium text-slate-500">{scope.id}</span></span>
                    <span className="mt-0.5 block text-[12.5px] leading-relaxed text-slate-500">{scope.description}</span>
                  </span>
                </label>
              )
            })}
          </div>

          <div className="grid gap-3 sm:flex sm:justify-end">
            <Button variant="outline" type="button" onClick={() => setCreateOpen(false)} disabled={loading}>Cancel</Button>
            <Button type="submit" disabled={loading || chosenScopes.length === 0}>{loading ? 'Creating…' : 'Create key'}</Button>
          </div>
        </form>
      </DummyModal>
    </>
  )
}
