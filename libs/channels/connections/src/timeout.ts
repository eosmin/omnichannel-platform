// Rejects when the work takes longer than `ms`. The work itself is not stopped (a promise cannot be),
// but nobody waits for it any more.
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the call to the provider timed out')), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

export { errorName } from '@platform/core/errors'
