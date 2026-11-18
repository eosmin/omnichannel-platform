import { storedKeyOf } from './stored-key'

describe('storedKeyOf', () => {
  it('stores the key of a person as it came, and none as null', () => {
    expect(storedKeyOf('k-1', null)).toBe('k-1')
    expect(storedKeyOf(undefined, null)).toBeNull()
    expect(storedKeyOf(undefined, 'plugin-1')).toBeNull()
  })

  it('keeps the key of a plugin in the namespace of that plugin, so two plugins never share one', () => {
    expect(storedKeyOf('k-1', 'plugin-1')).toBe('plugin:plugin-1:k-1')
    expect(storedKeyOf('k-1', 'plugin-1')).not.toBe(storedKeyOf('k-1', 'plugin-2'))
    expect(storedKeyOf('k-1', 'plugin-1')).not.toBe(storedKeyOf('k-1', null))
  })
})
