import { AUDIO_SPEEDS, clockOf, nextSpeed, positionOf } from './audio-clock'

describe('clockOf', () => {
  it.each([
    [0, '0:00'],
    [5.9, '0:05'],
    [65, '1:05'],
    [600, '10:00'],
    [3725, '62:05']
  ])('writes %s seconds as %s', (seconds, text) => {
    expect(clockOf(seconds)).toBe(text)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -4])('writes %s as 0:00', seconds => {
    expect(clockOf(seconds)).toBe('0:00')
  })
})

describe('nextSpeed', () => {
  it('goes 1x, 1.5x, 2x and back', () => {
    expect(AUDIO_SPEEDS).toEqual([1, 1.5, 2])
    expect(nextSpeed(1)).toBe(1.5)
    expect(nextSpeed(1.5)).toBe(2)
    expect(nextSpeed(2)).toBe(1)
  })

  it('starts again from 1x on a speed it does not know', () => {
    expect(nextSpeed(3)).toBe(1)
  })
})

describe('positionOf', () => {
  it('maps a point of the bar to a second of the audio', () => {
    expect(positionOf({ x: 50, left: 0, width: 200, duration: 60 })).toBe(15)
  })

  it('stays inside the audio when the pointer is past either end', () => {
    expect(positionOf({ x: -30, left: 0, width: 200, duration: 60 })).toBe(0)
    expect(positionOf({ x: 900, left: 0, width: 200, duration: 60 })).toBe(60)
  })

  it('gives 0 when the length or the duration is not known', () => {
    expect(positionOf({ x: 10, left: 0, width: 0, duration: 60 })).toBe(0)
    expect(positionOf({ x: 10, left: 0, width: 100, duration: Number.NaN })).toBe(0)
  })
})
