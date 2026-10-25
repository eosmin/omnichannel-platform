import { isUniqueViolation } from './unique-violation'

describe('isUniqueViolation', () => {
  it('recognises the Prisma error of a unique constraint', () => {
    expect(isUniqueViolation(Object.assign(new Error('x'), { code: 'P2002' }))).toBe(true)
  })

  it.each([
    ['another Prisma code', Object.assign(new Error('x'), { code: 'P2025' })],
    ['an error with no code', new Error('x')],
    ['null', null],
    ['a string', 'P2002']
  ])('does not take %s for one', (_label, error) => {
    expect(isUniqueViolation(error)).toBe(false)
  })
})
