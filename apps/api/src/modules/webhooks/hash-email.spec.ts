import { hashEmail } from './hash-email'

describe('hashEmail', () => {
  it('is stable across case and spaces, and short', () => {
    expect(hashEmail(' Person@Example.com ')).toBe(hashEmail('person@example.com'))
    expect(hashEmail('person@example.com')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs between addresses', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'))
  })
})
