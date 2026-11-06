// The short tone of a notification whose payload says `sound: true` (NOT-21). It is drawn with Web
// Audio, so no file is downloaded, and this module is loaded the first time a tone is due (a dynamic
// import in `realtime-sync.ts`), so the initial bundle of the inbox does not carry it.
export const NotificationTone = {
  FREQUENCY_HZ: 880,
  DURATION_S: 0.18,
  PEAK_GAIN: 0.08,
  ATTACK_S: 0.01,
  // A burst of notifications sounds once: tones closer than this to the last one are dropped
  MIN_GAP_S: 0.4
} as const

// What the tone reads of an `AudioContext`; the real one satisfies it and a spec can stand in for it
export interface ToneContext {
  readonly state: AudioContextState
  readonly currentTime: number
  readonly destination: AudioNode
  resume(): Promise<void>
  createOscillator(): OscillatorNode
  createGain(): GainNode
}

// Plays one tone and says whether it did. A page the person has not interacted with yet leaves the
// context suspended (the browser's autoplay rule): the tone is skipped, never queued, and `resume()`
// is asked without waiting for it, because a browser holds that promise until the next click and a
// tone played then would announce something that is no longer new. Once the person has interacted,
// the pending `resume()` settles and the next notification sounds. `lastStart` is the context time of
// the previous tone, to drop the rest of a burst.
export function playTone(
  context: ToneContext,
  lastStart = Number.NEGATIVE_INFINITY
): number | null {
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  if (context.state !== 'running') return null
  const start = context.currentTime
  if (start - lastStart < NotificationTone.MIN_GAP_S) return null
  const end = start + NotificationTone.DURATION_S
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = NotificationTone.FREQUENCY_HZ
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(NotificationTone.PEAK_GAIN, start + NotificationTone.ATTACK_S)
  gain.gain.linearRampToValueAtTime(0, end)
  oscillator.onended = () => {
    oscillator.disconnect()
    gain.disconnect()
  }
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(start)
  oscillator.stop(end)
  return start
}

let shared: AudioContext | undefined
let lastStart: number | undefined

// The tone of the page: one context for all of them, made at the first use. Never throws: a sound is
// not worth an error.
export function playNotificationTone(): boolean {
  try {
    if (typeof AudioContext === 'undefined') return false
    shared ??= new AudioContext()
    const started = playTone(shared, lastStart)
    if (started === null) return false
    lastStart = started
    return true
  } catch {
    return false
  }
}
