const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const
export const DURATION_PATTERN = /^(\d+)([smhd])$/

// "15m" -> 900. The env holds durations as text, the code works in seconds.
export function durationToSeconds(value: string): number {
  const match = DURATION_PATTERN.exec(value)
  const amount = match?.[1]
  const unit = match?.[2]
  if (amount === undefined || unit === undefined) {
    throw new Error(`"${value}" is not a duration: use a number and s, m, h or d (for example 15m)`)
  }
  return Number(amount) * UNIT_SECONDS[unit as keyof typeof UNIT_SECONDS] // The pattern admits only these four
}
