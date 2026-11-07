import { charCounterOf } from './char-counter'

describe('charCounterOf', () => {
  it('says nothing until the text is near its limit', () => {
    expect(charCounterOf(0, 4096)).toBeNull()
    expect(charCounterOf(3276, 4096)).toBeNull()
  })

  it('counts what is left from 80% on', () => {
    expect(charCounterOf(3277, 4096)).toMatchObject({ left: 819, atLimit: false })
    expect(charCounterOf(4000, 4096)).toMatchObject({ left: 96 })
  })

  it('knows when the limit is reached, and never goes below zero', () => {
    expect(charCounterOf(4096, 4096)).toMatchObject({ left: 0, atLimit: true })
    expect(charCounterOf(5000, 4096)).toMatchObject({ left: 0, atLimit: true })
  })

  it('moves to the next step exactly at 80, 90, 95 and 100% of the limit', () => {
    const step = (length: number): number | undefined => charCounterOf(length, 1000)?.step
    expect([
      step(799),
      step(800),
      step(899),
      step(900),
      step(949),
      step(950),
      step(999),
      step(1000)
    ]).toEqual([undefined, 1, 1, 2, 2, 3, 3, 4])
  })

  it('announces only when the step changes, not at every key', () => {
    const steps = new Set<number>()
    for (let length = 3277; length <= 4096; length += 1) {
      steps.add(charCounterOf(length, 4096)?.step ?? -1)
    }
    // From 80% to the limit there are a handful of steps, not hundreds
    expect(steps.size).toBeLessThanOrEqual(6)
    expect(charCounterOf(3300, 4096)?.step).toBe(charCounterOf(3310, 4096)?.step)
  })
})
