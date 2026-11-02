import { createHash } from 'node:crypto'
import { Transform } from 'node:stream'
import type { File } from '@prisma/client'

/**
 * S3-style objects on top of the file table.
 *
 * A file uploaded through the dashboard is addressed by id; an object is
 * addressed by path. Both live in `files` - `object_key` is the path, and it is
 * unique per user, which is what makes `PUT` to the same key an overwrite rather
 * than a second copy.
 */
export const MAX_OBJECT_KEY_LENGTH = 700

export type ObjectProblem = 'empty' | 'too_long' | 'leading_slash' | 'trailing_slash' | 'empty_segment' | 'dot_segment' | 'control_char'

/**
 * Reject anything that would be ambiguous as a path.
 *
 * `..` matters most: it is the one key that could escape the per-file prefix on
 * an S3-compatible provider that resolves it. The key is otherwise opaque - no
 * normalisation, no case folding - because two callers that agree on a string
 * must land on the same object.
 */
export function objectKeyProblem(key: string): ObjectProblem | null {
  if (!key) return 'empty'
  if (key.length > MAX_OBJECT_KEY_LENGTH) return 'too_long'
  if (key.startsWith('/')) return 'leading_slash'
  if (key.endsWith('/')) return 'trailing_slash'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return 'control_char'
  const segments = key.split('/')
  if (segments.some((segment) => segment.length === 0)) return 'empty_segment'
  if (segments.some((segment) => segment === '.' || segment === '..')) return 'dot_segment'
  return null
}

export function objectKeyMessage(problem: ObjectProblem) {
  switch (problem) {
    case 'empty':
      return 'The object key is empty. PUT /api/v1/objects/<key> needs a key after /objects/.'
    case 'too_long':
      return `Object keys are limited to ${MAX_OBJECT_KEY_LENGTH} characters.`
    case 'leading_slash':
      return 'Object keys must not start with "/": /objects//a.txt is not the same object as /objects/a.txt.'
    case 'trailing_slash':
      return 'Object keys must not end with "/" - that is a prefix, not an object.'
    case 'empty_segment':
      return 'Object keys must not contain an empty segment ("//").'
    case 'dot_segment':
      return 'Object keys must not contain "." or ".." segments.'
    default:
      return 'Object keys must not contain control characters.'
  }
}

export function baseName(key: string) {
  const parts = key.split('/')
  return parts[parts.length - 1] ?? key
}

export function etagOf(file: Pick<File, 'checksum'>) {
  // S3 quotes its ETags; a client that stores the header should get the quotes back.
  return file.checksum ? `"${file.checksum}"` : null
}

/** Counts bytes and MD5s them on the way through, so the ETag costs no second pass. */
export function hashingStream() {
  const hash = createHash('md5')
  let bytes = 0
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  return {
    stream,
    result: () => ({ checksum: hash.digest('hex'), bytes }),
  }
}


export type ListEntry = { key: string; sizeBytes: string; lastModified: string; etag: string | null; mimeType: string }
export type ListResult = { objects: ListEntry[]; prefixes: string[]; isTruncated: boolean; nextContinuationToken: string | null; scanned: number }

export type Continuation = { after: string; skippedPrefix: string | null }

export function encodeContinuation(state: Continuation) {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
}

export function decodeContinuation(token: string | undefined): Continuation | null {
  if (!token) return null
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Continuation
    if (typeof parsed?.after !== 'string') return null
    return { after: parsed.after, skippedPrefix: typeof parsed.skippedPrefix === 'string' ? parsed.skippedPrefix : null }
  } catch {
    return null
  }
}
