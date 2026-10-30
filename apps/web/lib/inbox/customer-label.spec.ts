import { customerLabelOf, initialsOf } from './customer-label'

const customer = (over: Partial<Parameters<typeof customerLabelOf>[0]>) => ({
  id: 'u1',
  name: null,
  displayIdentity: '17871234567',
  username: null,
  avatarUrl: null,
  ...over
})

describe('customerLabelOf', () => {
  it('prefers the name', () => {
    expect(customerLabelOf(customer({ name: ' Ana Gómez ', username: 'ana' }))).toEqual({
      kind: 'name',
      text: 'Ana Gómez'
    })
  })

  it('falls back to the username with its @', () => {
    expect(customerLabelOf(customer({ name: '  ', username: 'ana_g' }))).toEqual({
      kind: 'username',
      text: '@ana_g'
    })
  })

  it('does not double the @ of a handle that has one', () => {
    expect(customerLabelOf(customer({ username: '@maria' }))).toEqual({
      kind: 'username',
      text: '@maria'
    })
  })

  it('falls back to the end of the identity', () => {
    expect(customerLabelOf(customer({}))).toEqual({ kind: 'identity', lastDigits: '4567' })
  })
})

describe('initialsOf', () => {
  it('takes the first and last word of a name', () => {
    expect(initialsOf({ kind: 'name', text: 'ana maría gómez' })).toBe('AG')
  })

  it('takes one letter of a single word and skips the @', () => {
    expect(initialsOf({ kind: 'username', text: '@ana_g' })).toBe('A')
  })

  it('does not split an emoji', () => {
    expect(initialsOf({ kind: 'name', text: '😀 Ana' })).toBe('😀A')
  })

  it('has a mark for an identity with no name', () => {
    expect(initialsOf({ kind: 'identity', lastDigits: '4567' })).toBe('#')
  })
})
