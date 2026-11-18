import { idempotencyKeySchema } from '@platform/core/domain'

import { rawKeyOf, storedKeyOf } from './stored-key'

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

  it('gives back the key the author wrote', () => {
    expect(rawKeyOf(storedKeyOf('k-1', 'plugin-1'))).toBe('k-1')
    expect(rawKeyOf('k-1')).toBe('k-1')
    expect(rawKeyOf(null)).toBeNull()
  })

  // The namespace of a plugin never meets the key of a person because a key cannot hold `:`: the day the alphabet grows, this fails
  it('keeps the key alphabet free of the separator of the namespace', () => {
    expect(idempotencyKeySchema.safeParse('plugin:p:k').success).toBe(false)
  })
})
