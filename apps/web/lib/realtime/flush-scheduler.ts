import type { OfflineQueue } from './offline-queue'
import { RealtimeClientTiming } from './realtime-config'

// A queue that cannot be read has not been emptied: it counts as having something left
function stillWaiting(queue: Pick<OfflineQueue, 'waiting'>, userId: string): number {
  try {
    return queue.waiting(userId).length
  } catch {
    return 1
  }
}

export interface FlushScheduler {
  // Sends what is waiting now and, if some of it could not go, tries again later
  trigger: () => void
  stop: () => void
}

// The socket coming back is one reason to send the queue; a send that fails while the socket stays up
// (a 502, a session being refreshed) is another, and nothing would call the queue again until the next
// reconnection. So a pass that leaves something waiting schedules the next one, with a growing wait.
export function createFlushScheduler(
  queue: Pick<OfflineQueue, 'flush' | 'waiting'>,
  userId: string,
  timing: { firstMs: number; maxMs: number } = {
    firstMs: RealtimeClientTiming.QUEUE_RETRY_MS,
    maxMs: RealtimeClientTiming.QUEUE_RETRY_MAX_MS
  }
): FlushScheduler {
  let stopped = false
  let running = false
  // Asked for while a pass was in flight: that pass took its list at the start and may not hold
  // what was written since
  let askedAgain = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const run = async (): Promise<void> => {
    if (stopped) return
    // A pass in flight schedules the next one itself (a second one would leave two timers), but a
    // request that came during it is answered as soon as it ends
    if (running) {
      askedAgain = true
      return
    }
    running = true
    askedAgain = false
    clear()
    try {
      await queue.flush(userId)
    } catch {
      // A pass that threw sent nothing it can vouch for: what is still waiting is tried again below
    } finally {
      running = false
    }
    if (stopped) return
    if (askedAgain) {
      attempt = 0
      return run()
    }
    if (stillWaiting(queue, userId) === 0) {
      attempt = 0
      return
    }
    const wait = Math.min(timing.firstMs * 2 ** attempt, timing.maxMs)
    attempt += 1
    timer = setTimeout(() => void run(), wait)
  }

  return {
    trigger: () => {
      if (!stopped) void run()
    },
    stop: () => {
      stopped = true
      clear()
    }
  }
}
