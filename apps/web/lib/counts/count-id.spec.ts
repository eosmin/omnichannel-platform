import { isCountId } from './count-id'

describe('isCountId', () => {
  it('accepts a UUID', () => {
    expect(isCountId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true)
    expect(isCountId('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe(true)
  })

  it.each(['', 'new', '../orders', '0f8fad5b-d9cb-469f-a165-70867728950e/start', '0f8fad5b'])(
    'refuses %p',
    value => {
      expect(isCountId(value)).toBe(false)
    }
  )
})
