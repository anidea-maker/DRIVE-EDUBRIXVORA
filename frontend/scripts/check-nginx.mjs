#!/usr/bin/env node
/**
 * Validates `nginx.conf.template` without needing nginx.
 *
 * Two deploys have now died at container start on config that TypeScript and
 * Vite were perfectly happy with:
 *
 *   [emerg] host not found in upstream "backend"
 *   [emerg] "default_type" directive is not allowed here
 *
 * nginx only reports the first problem, and only at runtime, so this script
 * renders the template for every supported deployment shape and checks the
 * directive contexts against nginx's documented rules.
 *
 * Run with `npm run check:nginx` (also part of `npm run build`, so a broken
 * template fails the image build instead of the deploy).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = path.join(frontendDir, 'nginx.conf.template')

/** Directive -> contexts it may appear in (nginx http core / proxy / rewrite docs). */
const CONTEXTS = {
  gzip: ['http'],
  gzip_comp_level: ['http'],
  gzip_min_length: ['http'],
  gzip_proxied: ['http'],
  gzip_types: ['http'],
  server: ['http'],
  listen: ['server'],
  server_name: ['server'],
  client_max_body_size: ['http', 'server', 'location'],
  root: ['http', 'server', 'location', 'if'],
  index: ['http', 'server', 'location'],
  resolver: ['http', 'server', 'location'],
  set: ['server', 'location', 'if'],
  error_page: ['http', 'server', 'location', 'if'],
  default_type: ['http', 'server', 'location'],
  add_header: ['http', 'server', 'location', 'if'],
  return: ['server', 'location', 'if'],
  access_log: ['http', 'server', 'location', 'if'],
  location: ['server', 'location'],
  try_files: ['server', 'location'],
  rewrite: ['server', 'location', 'if'],
  expires: ['http', 'server', 'location', 'if'],
  proxy_pass: ['location', 'if', 'limit_except'],
  proxy_ssl_server_name: ['http', 'server', 'location'],
  proxy_http_version: ['http', 'server', 'location'],
  proxy_set_header: ['http', 'server', 'location'],
  proxy_request_buffering: ['http', 'server', 'location'],
  proxy_buffering: ['http', 'server', 'location'],
  proxy_connect_timeout: ['http', 'server', 'location'],
  proxy_read_timeout: ['http', 'server', 'location'],
  proxy_send_timeout: ['http', 'server', 'location'],
  client_body_timeout: ['http', 'server', 'location'],
  send_timeout: ['http', 'server', 'location'],
}

/** Deployment shapes the image supports. */
const SCENARIOS = {
  'render (public api)': {
    PORT: '10000',
    API_UPSTREAM: 'https://9drive-backend.onrender.com',
    RESOLVER: '8.8.8.8 1.1.1.1',
    API_HINT: '',
  },
  'render (API_UPSTREAM unset -> docker default)': {
    PORT: '10000',
    API_UPSTREAM: 'http://backend:4000',
    RESOLVER: '8.8.8.8 1.1.1.1',
    API_HINT: '',
  },
  'render (self-reference guard)': {
    PORT: '10000',
    API_UPSTREAM: 'http://api-upstream-not-configured.invalid:9',
    RESOLVER: '8.8.8.8 1.1.1.1',
    API_HINT: 'API_UPSTREAM currently points at this same service (self-reference). ',
  },
  'docker compose': { PORT: '80', API_UPSTREAM: 'http://backend:4000', RESOLVER: '127.0.0.11', API_HINT: '' },
}

/** Mimics nginx's 20-envsubst-on-templates.sh: replaces ${VAR} for defined vars only. */
function render(template, env) {
  let out = template
  for (const [key, value] of Object.entries(env)) {
    out = out.split(`\${${key}}`).join(value).split(`$${key}`).join(value)
  }
  return out
}

function validate(name, template, env) {
  const problems = []
  const config = render(template, env)

  const unresolved = config.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g)
  if (unresolved) problems.push(`unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`)

  const stack = []
  const contextLabel = (head) => {
    const kind = head.split(/\s+/)[0]
    return kind === 'location' ? head : kind
  }

  config.split('\n').forEach((line, index) => {
    const text = line.trim()
    const at = `line ${index + 1}`
    if (!text || text.startsWith('#')) return

    if (text === '}') {
      if (stack.length === 0) problems.push(`${at}: unexpected '}'`)
      stack.pop()
      return
    }

    if (/^[^{}]*\{$/.test(text)) {
      const head = text.slice(0, -1).trim()
      const kind = head.split(/\s+/)[0]
      const parent = stack[stack.length - 1] ?? 'http'
      if (CONTEXTS[kind] && !CONTEXTS[kind].includes(parent.split(/\s+/)[0])) {
        problems.push(`${at}: '${kind}' is not allowed in '${parent}' (nginx will refuse the config)`)
      }
      stack.push(contextLabel(head))
      return
    }

    const directive = text.split(/\s+/)[0].replace(/;$/, '')
    const parent = stack[stack.length - 1] ?? 'http'
    const parentKind = parent.split(/\s+/)[0]

    if (parentKind === 'limit_except') {
      // limit_except accepts access/auth/proxy directives only.
      if (!['proxy_pass', 'allow', 'deny', 'auth_basic', 'auth_basic_user_file'].includes(directive)) {
        problems.push(`${at}: '${directive}' is not allowed inside limit_except`)
      }
    } else if (CONTEXTS[directive] && !CONTEXTS[directive].includes(parentKind)) {
      problems.push(`${at}: '${directive}' is not allowed in '${parentKind}'`)
    }
    if (!text.endsWith(';')) problems.push(`${at}: missing ';' -> ${text.slice(0, 60)}`)
  })

  if (stack.length !== 0) problems.push(`unbalanced braces (${stack.length} unclosed)`)

  // Every inline JSON body must still parse after substitution.
  for (const match of config.matchAll(/return \d+ '(\{.*?\})';/g)) {
    try {
      JSON.parse(match[1])
    } catch (error) {
      problems.push(`invalid JSON body: ${error.message}`)
    }
  }

  return problems
}

const template = fs.readFileSync(templatePath, 'utf8')
let failed = false

for (const [name, env] of Object.entries(SCENARIOS)) {
  const problems = validate(name, template, env)
  if (problems.length > 0) {
    failed = true
    console.error(`✗ ${name}`)
    for (const problem of problems) console.error(`  - ${problem}`)
  } else {
    console.log(`✓ ${name}`)
  }
}

if (failed) {
  console.error('\nnginx.conf.template would break at container start. Fix the entries above.')
  process.exit(1)
}

console.log(`\nnginx.conf.template is valid for ${Object.keys(SCENARIOS).length} deployment scenarios.`)
