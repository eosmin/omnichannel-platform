// A promise that gives up after `ms`: the caller reads `null` as "no answer". The slow call is not cancelled (a promise cannot be), only
// no longer waited for; the timer is always cleared so that it never keeps a process alive.
export async function withTimeout<T>(call: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const gaveUp = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([call(), gaveUp])
  } finally {
    clearTimeout(timer)
  }
}
