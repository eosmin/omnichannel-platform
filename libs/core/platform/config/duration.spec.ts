import { durationToSeconds } from './duration'

describe('durationToSeconds', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['2h', 7200],
    ['7d', 604_800]
  ])('reads %s as %i seconds', (text, seconds) => {
    expect(durationToSeconds(text)).toBe(seconds)
  })

  it.each(['', '15', 'm', '1.5h', '-5m', '10 m', '15M', '1w'])('refuses %j', text => {
    expect(() => durationToSeconds(text)).toThrow(/not a duration/)
  })
})
