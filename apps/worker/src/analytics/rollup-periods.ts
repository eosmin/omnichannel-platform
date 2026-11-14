import { RollupLimits } from '@platform/core/analytics'

export const RollupGranularities = { HOURLY: 'hourly', DAILY: 'daily' } as const
export type RollupGranularity = (typeof RollupGranularities)[keyof typeof RollupGranularities]

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

const LengthOf: Record<RollupGranularity, number> = {
  [RollupGranularities.HOURLY]: HOUR_MS,
  [RollupGranularities.DAILY]: DAY_MS
}

export interface RollupPeriod {
  start: Date
  end: Date
}

// A period is a whole hour or a whole UTC day. The epoch is midnight UTC, so a multiple of the length is a boundary.
export function isAligned(granularity: RollupGranularity, start: Date, end: Date): boolean {
  const length = LengthOf[granularity]
  return start.getTime() % length === 0 && end.getTime() - start.getTime() === length
}

// The latest closed periods, the newest first: each run recomputes the last RECOMPUTE_PERIODS, so a webhook that arrives
// late is absorbed by the next run (TDD_08 §6). The period that is still running is never written.
export function periodsToRecompute(granularity: RollupGranularity, now: Date): RollupPeriod[] {
  const length = LengthOf[granularity]
  const currentStart = Math.floor(now.getTime() / length) * length
  return Array.from({ length: RollupLimits.RECOMPUTE_PERIODS }, (_, index) => {
    const start = currentStart - (index + 1) * length
    return { start: new Date(start), end: new Date(start + length) }
  })
}
