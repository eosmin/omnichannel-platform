// How many buttons wait for the server right now. A screen reader needs a live region that is already on the
// page when its text changes, and a button must not change its own words (a longer label would resize it, and
// a status inside a button is not announced): so the buttons count themselves here and one region of the app
// (`BusyAnnouncer`) says it.
let busyCount = 0
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

export function subscribeToBusy(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const readBusyCount = (): number => busyCount

// Counts one waiting button; returns the way to stop counting it
export function startBusy(): () => void {
  busyCount += 1
  notify()
  let isStopped = false
  return () => {
    if (isStopped) return
    isStopped = true
    busyCount -= 1
    notify()
  }
}
