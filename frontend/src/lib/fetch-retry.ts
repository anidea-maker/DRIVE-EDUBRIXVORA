/**
 * Retrying wrapper around `fetch` for idempotent requests.
 *
 * Why this exists: a single dropped connection is the most common cause of the
 * dreaded "Failed to fetch" - the API process restarting (tsx watch, a deploy, a
 * free-tier instance waking up) or a proxy losing the upstream socket. None of
 * those mean the request was wrong, so retrying a couple of times with backoff
 * turns a red banner into a slightly slower response.
 *
 * Only idempotent methods are retried, and never after the caller aborted.
 */

export interface RetryInfo {
  attempt: number
  delayMs: number
  error?: unknown
  response?: Response
}

export interface RetryOptions {
  /** Total tries, including the first one. */
  attempts?: number
  /** Delay before each retry; the last value is reused when attempts run out. */
  delays?: number[]
  /** Called before waiting, useful for logging or UI feedback. */
  onRetry?: (info: RetryInfo) => void
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_DELAYS = [400, 1200, 2500]

/** GET/HEAD can be repeated without side effects. */
export function isIdempotent(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD'
}

/**
 * Gateway-ish statuses mean "the request never reached the application": an
 * nginx/Vite proxy with a dead upstream, Render holding a request while the
 * instance boots, or a restart in progress. Safe to repeat.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function fetchWithRetry(
  input: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const delays = options.delays?.length ? options.delays : DEFAULT_DELAYS
  const sleep = options.sleep ?? defaultSleep
  const retryable = isIdempotent(init.method)
  const signal = init.signal ?? undefined

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(input, init)
      const exhausted = attempt === attempts || !retryable || !isRetryableStatus(response.status)
      if (exhausted) return response

      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)]
      options.onRetry?.({ attempt, delayMs, response })
      await sleep(delayMs)
    } catch (error) {
      // Never retry a request the caller cancelled on purpose.
      if (signal?.aborted) throw error
      lastError = error
      if (attempt === attempts || !retryable) throw error

      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)]
      options.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }

  // Unreachable in practice: the loop either returns or throws.
  throw lastError ?? new Error('Request failed')
}
