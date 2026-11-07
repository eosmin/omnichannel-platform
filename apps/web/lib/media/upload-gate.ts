// At most `size` uploads at a time: the files of a message start together and the browser, the bucket and the
// connection of the agent are not asked for thirty at once. A waiting turn leaves when its signal aborts.
export function uploadGate(
  size: number
): <T>(task: () => Promise<T>, signal: AbortSignal) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []
  // The place goes straight to the next in line: freeing it first would let a newcomer take it before the
  // waiter wakes, and one more than `size` would run
  const release = (): void => {
    const next = waiting.shift()
    if (next === undefined) running -= 1
    else next()
  }
  return async (task, signal) => {
    if (running >= size) {
      // `running` already counts the place that is handed over
      await new Promise<void>((resolve, reject) => {
        const turn = (): void => {
          signal.removeEventListener('abort', leave)
          resolve()
        }
        const leave = (): void => {
          const at = waiting.indexOf(turn)
          if (at !== -1) waiting.splice(at, 1)
          reject(signal.reason as Error)
        }
        waiting.push(turn)
        signal.addEventListener('abort', leave, { once: true })
      })
    } else running += 1
    try {
      signal.throwIfAborted()
      return await task()
    } finally {
      release()
    }
  }
}
