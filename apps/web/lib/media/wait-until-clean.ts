import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

export const CLEAN_POLL_INTERVAL_MS = 1500
// Scanning and the variants of a large file take seconds; a minute without a verdict is a failure
export const CLEAN_POLL_MAX_TRIES = 40

// Asks until the file has a verdict. `check` is GET /media/:id, which answers FILE_NOT_READY until
// the file is clean and FILE_INFECTED when it is not. Resolves when clean; throws the api error of an
// infected file, FILE_NOT_READY when the tries run out, and any other failure as it is.
export async function waitUntilClean(
  check: () => Promise<unknown>,
  options: {
    signal: AbortSignal
    intervalMs?: number
    maxTries?: number
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  }
): Promise<void> {
  const {
    signal,
    intervalMs = CLEAN_POLL_INTERVAL_MS,
    maxTries = CLEAN_POLL_MAX_TRIES,
    sleep = sleepFor
  } = options
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    signal.throwIfAborted()
    try {
      await check()
      return
    } catch (error) {
      if (!(error instanceof ApiError) || !error.is(ErrorCodes.FILE_NOT_READY)) throw error
    }
    if (attempt < maxTries) await sleep(intervalMs, signal)
  }
  throw new ApiError(409, ErrorCodes.FILE_NOT_READY, 'The file has no verdict yet')
}

function sleepFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
