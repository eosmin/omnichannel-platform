import { RealtimeEvents, SocketLimits } from '@platform/core/realtime'

import type { RealtimeSocket } from './connection'

// What counts as the person doing something. An open tab alone only proves the tab is open.
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const

export interface ActivityTracker {
  // Whether the person did something since the last call
  consume: () => boolean
  stop: () => void
}

export function trackActivity(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>
): ActivityTracker {
  // The page was just opened by someone
  let active = true
  const mark = (): void => {
    active = true
  }
  ACTIVITY_EVENTS.forEach(name => target.addEventListener(name, mark, { passive: true }))
  return {
    consume: () => {
      const was = active
      active = false
      return was
    },
    stop: () => ACTIVITY_EVENTS.forEach(name => target.removeEventListener(name, mark))
  }
}

// One heartbeat when the socket connects and then one every 30 s while it is up, so that the
// presence of the person survives a lost beat (a socket stays online for 60 s without one).
export function startHeartbeat(
  socket: RealtimeSocket,
  activity: Pick<ActivityTracker, 'consume'>,
  intervalMs: number = SocketLimits.HEARTBEAT_INTERVAL_SECONDS * 1000
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null

  const beat = (): void => {
    // The activity is consumed only by a beat that can leave
    if (!socket.connected) return
    // Volatile: one that finds the socket down is dropped, not delivered stale after the reconnection
    socket.volatile.emit(RealtimeEvents.HEARTBEAT, { active: activity.consume() })
  }
  const stop = (): void => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  const start = (): void => {
    stop()
    beat()
    timer = setInterval(beat, intervalMs)
  }

  socket.on('connect', start)
  socket.on('disconnect', stop)
  if (socket.connected) start()

  return () => {
    stop()
    socket.off('connect', start)
    socket.off('disconnect', stop)
  }
}
