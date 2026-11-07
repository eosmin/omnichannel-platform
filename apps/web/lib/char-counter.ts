// When a field with a limit starts to count what is left: from 80% of it
const COUNT_FROM = 0.8
// The announcement to a screen reader changes at these shares of the limit, not at every key
const ANNOUNCE_AT = [0.8, 0.9, 0.95, 1] as const

export interface CharCounterState {
  left: number
  atLimit: boolean
  // Changes only when the announcement should: the live region says it again then
  step: number
}

// The counter of a field with a limit, or null while the text is far from it
export function charCounterOf(length: number, max: number): CharCounterState | null {
  if (max <= 0 || length < max * COUNT_FROM) return null
  const share = length / max
  const step = ANNOUNCE_AT.filter(threshold => share >= threshold).length
  return { left: Math.max(0, max - length), atLimit: length >= max, step }
}
