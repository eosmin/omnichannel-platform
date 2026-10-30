// Sends, then lets the screen read the thread again before the queue drops the message, so the bubble
// of the queue is replaced by the stored message without a gap. The wait is capped: the queue sends
// one message at a time, and a refresh that is slow or never comes back (the connection went down
// right after the send) must not hold back the messages behind it. A refresh that fails changes
// nothing: the message is already stored and the next event reads the thread again.
export async function sendThenRefresh<T>(
  send: () => Promise<T>,
  refresh: () => Promise<unknown>,
  maxWaitMs: number
): Promise<T> {
  const sent = await send()
  let timer: ReturnType<typeof setTimeout> | undefined
  const capped = new Promise<void>(resolve => {
    timer = setTimeout(resolve, maxWaitMs)
  })
  try {
    await Promise.race([refresh().catch(() => undefined), capped])
  } finally {
    clearTimeout(timer)
  }
  return sent
}
