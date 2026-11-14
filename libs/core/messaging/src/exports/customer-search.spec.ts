import { customerSearchWhere, phoneDigitsOf } from './customer-search'

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

describe('the customers a search text finds', () => {
  it('scopes to the store and leaves the absorbed customers out', () => {
    expect(customerSearchWhere(STORE, undefined, '')).toEqual({
      storeId: STORE,
      mergedIntoId: null
    })
  })

  it('compares the name with no accents and in lower case, so "jose" finds "José"', () => {
    const where = customerSearchWhere(STORE, 'JOSÉ Pérez', 'jose perez')
    expect(where.OR?.[0]).toEqual({ nameSearch: { contains: 'jose perez' } })
  })

  it('asks nothing of the name when the text folds to nothing: an empty LIKE would match everybody', () => {
    const where = customerSearchWhere(STORE, '\u0301\u0301', '')
    expect(where.OR?.some(clause => 'nameSearch' in clause)).toBe(false)
  })

  it('reads the name in the folded text it is given', () => {
    expect(customerSearchWhere(STORE, 'Søren', 'soren').OR?.[0]).toEqual({
      nameSearch: { contains: 'soren' }
    })
  })

  it('escapes the wildcards of LIKE in every clause', () => {
    const where = customerSearchWhere(STORE, '100%_a', '100%_a')
    expect(where.OR?.[0]).toEqual({ nameSearch: { contains: '100\\%\\_a' } })
    expect(where.OR?.[1]).toEqual({ email: { contains: '100\\%\\_a', mode: 'insensitive' } })
  })

  it('looks for the digits in the phones only when the text is a phone', () => {
    expect(customerSearchWhere(STORE, '7123-4567', '7123-4567').OR).toContainEqual({
      phoneNormalized: { contains: '71234567' }
    })
    expect(
      customerSearchWhere(STORE, 'Calle 123', 'calle 123').OR?.some(
        clause => 'phoneNormalized' in clause
      )
    ).toBe(false)
  })
})
