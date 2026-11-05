import { wantsSound } from './wants-sound'

describe('wantsSound', () => {
  it('is true only for a payload that says so', () => {
    expect(wantsSound({ id: 'n1', sound: true })).toBe(true)
  })

  it.each([
    ['no sound', { id: 'n1', sound: false }],
    ['no field', { id: 'n1' }],
    ['a field that is not a boolean', { sound: 'true' }],
    ['no payload', null],
    ['something that is not an object', 'sound']
  ])('is false for %s', (_name, payload) => {
    expect(wantsSound(payload)).toBe(false)
  })
})
