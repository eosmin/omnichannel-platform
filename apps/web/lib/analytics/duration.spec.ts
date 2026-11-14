import { durationParts, formatDuration } from './duration'

describe('durationParts', () => {
  it('keeps the two biggest units that are not zero', () => {
    expect(durationParts(222)).toEqual([
      { unit: 'minute', value: 3 },
      { unit: 'second', value: 42 }
    ])
    expect(durationParts(8280)).toEqual([
      { unit: 'hour', value: 2 },
      { unit: 'minute', value: 18 }
    ])
    // A time of a day does not carry its seconds
    expect(durationParts(90_061)).toEqual([
      { unit: 'day', value: 1 },
      { unit: 'hour', value: 1 }
    ])
    expect(durationParts(45)).toEqual([{ unit: 'second', value: 45 }])
  })

  it('drops a unit of zero between the two', () => {
    expect(durationParts(3605)).toEqual([{ unit: 'hour', value: 1 }])
  })

  it('writes zero seconds for a time of nothing and refuses what is not a time', () => {
    expect(durationParts(0)).toEqual([{ unit: 'second', value: 0 }])
    expect(durationParts(0.4)).toEqual([{ unit: 'second', value: 0 }])
    expect(durationParts(-1)).toBeNull()
    expect(durationParts(Number.NaN)).toBeNull()
  })
})

describe('formatDuration', () => {
  it('writes the units in the language of the person', () => {
    expect(formatDuration(222, 'en')).toBe('3m 42s')
    expect(formatDuration(222, 'es')).toMatch(/^3\s?min 42\s?s$/)
  })
})
