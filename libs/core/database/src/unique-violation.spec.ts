import { isUniqueViolation, isUniqueViolationOf } from './unique-violation'

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

describe('isUniqueViolationOf', () => {
  const violation = (message: string, details?: unknown) =>
    Object.assign(new Error(message), {
      code: 'P2002',
      ...(details === undefined ? {} : { meta: details })
    })

  it('names the index in the message or in the details of the driver', () => {
    expect(isUniqueViolationOf(violation('failed on the constraint: `uq_a`'), 'uq_a')).toBe(true)
    expect(isUniqueViolationOf(violation('x', { target: ['uq_a'] }), 'uq_a')).toBe(true)
  })

  it('is not another unique rule, another error or a value that is no error', () => {
    expect(isUniqueViolationOf(violation('failed on the constraint: `uq_b`'), 'uq_a')).toBe(false)
    expect(isUniqueViolationOf(new Error('uq_a'), 'uq_a')).toBe(false)
    expect(isUniqueViolationOf(null, 'uq_a')).toBe(false)
  })

  it('answers false, and does not throw, for details that cannot be written as text', () => {
    const loop: Record<string, unknown> = {}
    loop['self'] = loop
    expect(isUniqueViolationOf(violation('x', loop), 'uq_a')).toBe(false)
    expect(isUniqueViolationOf(violation('x', { size: BigInt(1) }), 'uq_a')).toBe(false)
  })
})
