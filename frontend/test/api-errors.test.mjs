/**
 * The messages `apiFetch` produces when a request fails.
 *
 * The bug these tests pin: a 404 whose body was *not* JSON used to surface as
 * `Request failed (404)` - the status code and nothing else. That is what a
 * static host answering `/api/*` itself, an nginx `try_files` miss, or a
 * misconfigured base URL all look like, so the one message the user got was the
 * one that identified none of them.
 *
 * `apiFetch` is exercised with a stubbed `fetch`, so this runs without a browser
 * or a backend. Only the error path is covered, which is the part that used to
 * lose information.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.VITE_API_URL = ''

/**
 * `api.ts` reads the access token from `localStorage` on every call. There is no
 * browser here, and the error path is what matters, so a minimal in-memory stand-in
 * is enough - no token means the request is made without an Authorization header,
 * exactly the shape under test.
 */
globalThis.localStorage ??= {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(String(key), String(value))
  },
  removeItem(key) {
    this.store.delete(key)
  },
  clear() {
    this.store.clear()
  },
}

/**
 * `api.ts` imports through the `@/` alias, which Node does not resolve. The app
 * is bundled for production anyway, so the test bundles this one module with the
 * same alias Vite uses and imports that. It keeps the test honest: it exercises
 * the shipped code, not a copy of it.
 */
const outDir = mkdtempSync(path.join(tmpdir(), 'api-errors-'))
const bundlePath = path.join(outDir, 'api.mjs')
execFileSync(
  process.execPath,
  [path.resolve(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.test.mjs', '--logLevel', 'silent'],
  {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, API_TEST_OUT_DIR: outDir },
  },
)
const { apiFetch } = await import(pathToFileURL(bundlePath).href)
test.after(() => rmSync(outDir, { recursive: true, force: true }))

const realFetch = globalThis.fetch

/** Installs a `fetch` that answers with exactly one canned response. */
function stubFetch(responses) {
  const calls = []
  let index = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return next()
  }
  return calls
}

function response(body, { status = 200, statusText = '', contentType = 'application/json' } = {}) {
  return new Response(body, { status, statusText, headers: contentType ? { 'Content-Type': contentType } : {} })
}

/** Runs one failing call and returns the thrown Error. */
async function failureOf(handler, path = '/files') {
  stubFetch([handler])
  try {
    await apiFetch(path)
    assert.fail('apiFetch should have thrown')
  } catch (error) {
    return error
  }
}

test.afterEach(() => {
  globalThis.fetch = realFetch
})

test('a JSON error keeps the API sentence and its stable code', async () => {
  const error = await failureOf(() => response(JSON.stringify({ code: 'API_KEY_SCOPE_MISSING', message: 'This key has [files:read] but the route needs "files:write".' }), { status: 403 }))
  assert.equal(error.message, 'This key has [files:read] but the route needs "files:write".')
  assert.equal(error.code, 'API_KEY_SCOPE_MISSING')
})

test('an empty 404 names the method and URL instead of only the status', async () => {
  const error = await failureOf(() => response('', { status: 404, contentType: '' }))
  assert.doesNotMatch(error.message, /^Request failed \(404\)$/)
  assert.match(error.message, /GET/)
  assert.match(error.message, /\/files/)
  assert.match(error.message, /empty response/)
  // The advice must name the thing that actually causes this in production.
  assert.match(error.message, /static files|did not reach the API/)
})

test('an HTML 404 explains that the request never reached the API', async () => {
  const error = await failureOf(() => response('<!doctype html><html><body>Not Found</body></html>', { status: 404, contentType: 'text/html' }))
  assert.match(error.message, /returned an HTML error page/)
  assert.match(error.message, /API_UPSTREAM/)
})

test('a 404 on the API base itself points at the base URL', async () => {
  const error = await failureOf(() => response('', { status: 404, contentType: '' }), '/')
  assert.match(error.message, /base URL is wrong/)
  assert.match(error.message, /must end in \/api/)
})

test('a 500 with an empty body is still diagnosable', async () => {
  const error = await failureOf(() => response('', { status: 500, statusText: 'Internal Server Error', contentType: '' }))
  assert.match(error.message, /500/)
  assert.match(error.message, /API_UPSTREAM|backend is running/)
  assert.doesNotMatch(error.message, /^Request failed/)
})

test('a non-JSON success body mentions what came back', async () => {
  stubFetch([() => response('upstream timeout', { status: 200, contentType: 'text/plain' })])
  await assert.rejects(() => apiFetch('/files'), /non-JSON response.*upstream timeout/)
})

test('a plain-text error body is surfaced verbatim', async () => {
  const error = await failureOf(() => response('rate limit exceeded', { status: 429, contentType: 'text/plain' }))
  assert.match(error.message, /rate limit exceeded/)
})
