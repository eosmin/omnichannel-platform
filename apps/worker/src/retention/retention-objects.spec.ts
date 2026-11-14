import { StorageKeys } from '@platform/core/storage'

import { objectKeysOf } from './retention-objects'

describe('objectKeysOf', () => {
  const storeId = 'store-a'

  it('names the original and each variant of a file', () => {
    const key = StorageKeys.message(storeId, 'm1', 'a.png')
    const thumb = StorageKeys.messageVariant(storeId, 'm1', 'thumb')

    expect(objectKeysOf(storeId, { key, variants: { thumb } }).keys).toEqual([key, thumb])
  })

  it('names the original once when a variant is the original', () => {
    const key = StorageKeys.message(storeId, 'm1', 'a.png')

    expect(objectKeysOf(storeId, { key, variants: { full: key } }).keys).toEqual([key])
  })

  it('leaves out a key of another store, which a damaged column could name', () => {
    const own = StorageKeys.message(storeId, 'm1', 'a.png')
    const foreign = StorageKeys.message('store-b', 'm2', 'b.png')

    expect(objectKeysOf(storeId, { key: own, variants: { thumb: foreign } })).toEqual({
      keys: [own],
      foreign: [foreign]
    })
    expect(objectKeysOf(storeId, { key: foreign, variants: null })).toEqual({
      keys: [],
      foreign: [foreign]
    })
  })

  it('ignores a variants column that is not a map of keys', () => {
    const key = StorageKeys.message(storeId, 'm1', 'a.png')

    for (const variants of [null, undefined, 'x', 3, [], { thumb: 1 }, { thumb: null }]) {
      expect(objectKeysOf(storeId, { key, variants }).keys).toEqual([key])
    }
  })
})
