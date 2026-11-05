// The sound of a notification that asked for one (the "Sonido" column of the preferences, QA NOT-21: the
// setting was saved and nothing played). One short tone made in the browser, so there is no audio file
// to ship. A browser that has not let the page play sound yet (no click or key so far), or one with no
// Web Audio, stays quiet: the notification itself is already in the bell.

const TONE_HZ = 880
const TONE_SECONDS = 0.18
const TONE_VOLUME = 0.08
const TONE_RAMP_SECONDS = 0.02

let context: AudioContext | undefined

export function playChime(): void {
  try {
    if (typeof AudioContext === 'undefined') return
    context ??= new AudioContext()
    const audio = context
    // A page that nobody has used yet cannot make sound: its clock is stopped, and a tone scheduled on it
    // would play, with those of every notification since, at the first click. Ask to resume and skip this one.
    if (audio.state !== 'running') {
      void audio.resume().catch(() => undefined)
      return
    }
    const now = audio.currentTime
    const oscillator = audio.createOscillator()
    const volume = audio.createGain()
    oscillator.frequency.value = TONE_HZ
    // A short rise and fall, so that the tone does not click at its ends
    volume.gain.setValueAtTime(0, now)
    volume.gain.linearRampToValueAtTime(TONE_VOLUME, now + TONE_RAMP_SECONDS)
    volume.gain.linearRampToValueAtTime(0, now + TONE_SECONDS)
    oscillator.connect(volume).connect(audio.destination)
    oscillator.onended = () => {
      oscillator.disconnect()
      volume.disconnect()
    }
    oscillator.start(now)
    oscillator.stop(now + TONE_SECONDS)
  } catch {
    // No sound is not a failure the person can act on
  }
}
