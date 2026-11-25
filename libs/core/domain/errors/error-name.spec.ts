import { errorName } from './error-name'

describe('errorName', () => {
  it('is the name of an error', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError')
  })

  it('is unknown for what is not an error', () => {
    expect(errorName('a@example.com')).toBe('unknown')
  })

  it('is unknown, and does not throw, when the name is a getter that throws', () => {
    const hostile = new Error('x')
    Object.defineProperty(hostile, 'name', {
      get: () => {
        throw new Error('no name for you')
      }
    })

    expect(errorName(hostile)).toBe('unknown')
  })
})
