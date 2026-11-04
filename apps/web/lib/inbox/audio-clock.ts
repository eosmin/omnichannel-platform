export const AUDIO_SPEEDS = [1, 1.5, 2] as const
export type AudioSpeed = (typeof AUDIO_SPEEDS)[number]

const SECONDS_PER_MINUTE = 60

// Minutes and seconds, "1:05"; an unknown or negative time (a stream with no length yet) is 0:00
export function clockOf(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  const rest = String(whole % SECONDS_PER_MINUTE).padStart(2, '0')
  return `${Math.floor(whole / SECONDS_PER_MINUTE)}:${rest}`
}

export function nextSpeed(current: number): AudioSpeed {
  const at = AUDIO_SPEEDS.findIndex(speed => speed === current)
  return AUDIO_SPEEDS[(at + 1) % AUDIO_SPEEDS.length] ?? AUDIO_SPEEDS[0]
}

// The second of the audio under a point of the bar, kept inside the audio
export function positionOf(input: {
  x: number
  left: number
  width: number
  duration: number
}): number {
  if (!(input.width > 0) || !Number.isFinite(input.duration) || input.duration <= 0) return 0
  const ratio = Math.min(1, Math.max(0, (input.x - input.left) / input.width))
  return ratio * input.duration
}
