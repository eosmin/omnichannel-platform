import { customerSearchPatterns, customerSearchWhere, phoneDigitsOf } from './customer-search'

const STORE = '11111111-1111-4111-8111-111111111111'

describe('phoneDigitsOf', () => {
  it.each([
    ['7123-4567', '71234567'],
    ['+503 7123 4567', '50371234567'],
    ['(503) 7123-4567', '50371234567'],
    ['1234', '1234']
  ])('reads %s as the digits of a phone', (text, digits) => {
    expect(phoneDigitsOf(text)).toBe(digits)
  })

  it.each(['Calle 123', 'ab12', '12', '123', '', 'jose'])('does not read %s as a phone', text => {
    expect(phoneDigitsOf(text)).toBe('')
  })
})

describe('the customers of a store', () => {
  it('scopes to the store and leaves the absorbed and the erased customers out', () => {
    expect(customerSearchWhere(STORE)).toEqual({
      storeId: STORE,
      mergedIntoId: null,
      erasedAt: null
    })
  })
})

describe('the patterns a search text is looked for with', () => {
  it('compares the name folded (no accents, lower case), so "jose" finds "José"', () => {
    expect(customerSearchPatterns('JOSÉ Pérez', 'jose perez').name).toBe('%jose perez%')
  })

  it('asks nothing of the name when the text folds to nothing: an empty LIKE would match everybody', () => {
    expect(customerSearchPatterns('\u0301\u0301', '').name).toBeNull()
  })

  it('compares the email as typed', () => {
    expect(customerSearchPatterns('Søren@X.com', 'soren@x.com').email).toBe('%Søren@X.com%')
  })

  it('escapes the wildcards of LIKE in the name and in the email', () => {
    const patterns = customerSearchPatterns('100%_a', '100%_a')
    expect(patterns.name).toBe('%100\\%\\_a%')
    expect(patterns.email).toBe('%100\\%\\_a%')
  })

  it('looks for the digits in the phones only when the text is a phone', () => {
    expect(customerSearchPatterns('7123-4567', '7123-4567').phone).toBe('%71234567%')
    expect(customerSearchPatterns('Calle 123', 'calle 123').phone).toBeNull()
  })
})
