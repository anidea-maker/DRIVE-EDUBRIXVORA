/**
 * `npm run db:check` - verifies the database configuration end to end.
 *
 * Prints the parsed DATABASE_URL (password masked), checks TCP reachability,
 * flags the mistakes that actually bite people with hosted MySQL
 * (Aiven / PlanetScale / Azure) and the bundled Docker MySQL, then runs a
 * query through Prisma.
 */
import net from 'node:net'
import { loadEnvFiles } from '../config/load-env.js'

loadEnvFiles()

const PLACEHOLDERS = [
  'CLICK_TO_REVEAL_PASSWORD',
  'REPLACE_WITH',
  'change-this-database-password',
  'your-password',
]

function stop(lines: string[]): never {
  console.error(['', ...lines, ''].join('\n'))
  process.exit(1)
}

function mask(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '********'
    return parsed.toString()
  } catch {
    return url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:********@')
  }
}

function checkTcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result: string) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(6000)
    socket.once('connect', () => done('ok'))
    socket.once('timeout', () => done('timeout'))
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? error.message))
  })
}

async function main() {
  const raw = process.env.DATABASE_URL?.trim()

  if (!raw) {
    stop([
      'DATABASE_URL is not set.',
      'Run `npm run env:setup` (creates backend/.env) or export it in your shell.',
    ])
  }

  if (!raw.startsWith('mysql://')) {
    stop([
      'DATABASE_URL must start with mysql:// (this project uses MySQL).',
      `  got: ${mask(raw)}`,
    ])
  }

  console.log(`DATABASE_URL  ${mask(raw)}`)

  const placeholder = PLACEHOLDERS.find((token) => raw.includes(token))
  if (placeholder) {
    stop([
      `DATABASE_URL still contains the placeholder "${placeholder}".`,
      'Open backend/.env and paste the real database password.',
      'Aiven: click "CLICK_TO_REVEAL_PASSWORD" on the service page, then copy the password.',
    ])
  }

  const parsed = new URL(raw)
  const params = parsed.searchParams
  const port = Number(parsed.port || 3306)

  console.log(`Database      ${parsed.pathname.replace(/^\//, '') || '(none)'}`)
  console.log(`User          ${decodeURIComponent(parsed.username)}`)

  if (params.has('ssl-mode') || params.has('sslmode')) {
    console.warn(
      [
        '',
        'Warning: Prisma MySQL does not read "ssl-mode" / "sslmode" - the parameter is',
        'ignored and the connection stays unencrypted. Use sslaccept instead:',
        '  sslaccept=accept_invalid_certs            encrypted, certificate not verified',
        '  sslcert=certs/aiven-ca.pem&sslaccept=strict  encrypted and verified',
        '(sslcert paths resolve relative to backend/prisma)',
        '',
      ].join('\n'),
    )
  }

  if (params.get('sslaccept') === 'strict' && !params.get('sslcert')) {
    console.warn(
      [
        '',
        'Warning: sslaccept=strict without sslcert fails against most managed MySQL',
        'servers. Save the CA certificate (Aiven: service page -> CA certificate) as',
        'backend/prisma/certs/aiven-ca.pem, then use sslcert=certs/aiven-ca.pem.',
        '',
      ].join('\n'),
    )
  }

  const host = parsed.hostname
  const reachable = await checkTcp(host, port)
  if (reachable === 'ok') {
    console.log(`TCP           ${host}:${port} reachable`)
  } else {
    stop([
      `TCP check failed: cannot reach ${host}:${port} (${reachable}).`,
      '',
      'Common causes:',
      '  - wrong host or port (copy both from the provider console)',
      '  - the database requires an IP allowlist / "trusted sources" entry for this IP',
      '  - the service is powered off, or the sandbox/network blocks outbound MySQL',
      '',
      'Re-test with:  nc -vz ' + host + ' ' + port,
    ])
  }

  let prisma: typeof import('../config/prisma.js').prisma
  try {
    ;({ prisma } = await import('../config/prisma.js'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stop([
      'Prisma Client is not generated yet, so the query check cannot run.',
      '',
      message.split('\n')[0],
      '',
      'Run `npm run prisma:generate`, then `npm run db:check` again.',
    ])
  }

  try {
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, string>>>(
      'SELECT VERSION() AS version, DATABASE() AS db, @@character_set_database AS charset',
    )
    const row = rows[0] ?? {}
    console.log(`Connected     ${row.db} (MySQL ${row.version}, ${row.charset})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hints: string[] = []
    if (/P1000/.test(message) || /Authentication failed/i.test(message)) {
      hints.push(
        'The host answered but the credentials were rejected.',
        '  - paste the exact password from the provider console (case sensitive)',
        '  - Aiven: user is "avnadmin", default database is "defaultdb"',
      )
    }
    if (/P1001|Can.t reach database server/i.test(message)) {
      hints.push('Check the host/port and the provider IP allowlist.')
    }
    if (/P1010|denied access/i.test(message)) {
      hints.push('That user cannot access that database. Aiven: use "defaultdb".')
    }
    if (/P1017|closed the connection/i.test(message)) {
      hints.push('The server closed the connection - usually TLS negotiation. Try sslaccept=accept_invalid_certs.')
    }

    stop([
      'Database query failed.',
      '',
      message,
      ...(hints.length ? ['', 'Hints:', ...hints.map((hint) => `  ${hint}`)] : []),
    ])
  }

  try {
    const applied = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      'SELECT COUNT(*) AS n FROM `_prisma_migrations`',
    )
    console.log(`Migrations    ${applied[0]?.n ?? 0} applied - see npm run db:status`)
  } catch {
    console.log('Migrations    none applied yet - run `npm run db:migrate:deploy`')
  }

  await prisma.$disconnect()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
