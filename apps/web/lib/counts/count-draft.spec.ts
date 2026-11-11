import { StorageKeys } from '@platform/api-client'
import { CountLimits } from '@platform/core/domain'

import {
  chunkEdits,
  type DraftStorage,
  draftKeyOf,
  loadDraft,
  onlyLinesOf,
  parseDraft,
  saveDraft,
  withoutConfirmed
} from './count-draft'

function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key)
  }
}

describe('the draft of a count sheet', () => {
  it('is kept by count, under the key of the draft', () => {
    expect(draftKeyOf('u1', 'c1')).toBe(`${StorageKeys.COUNT_DRAFT}:u1:c1`)
  })

  it('is saved and read back', () => {
    const storage = memoryStorage()
    saveDraft(storage, 'u1', 'c1', { a: 3, b: null })
    expect(loadDraft(storage, 'u1', 'c1')).toEqual({ a: 3, b: null })
    expect(loadDraft(storage, 'u1', 'c2')).toEqual({})
    // Another person on the same phone finds nothing
    expect(loadDraft(storage, 'u2', 'c1')).toEqual({})
  })

  it('leaves nothing behind when it is empty', () => {
    const storage = memoryStorage()
    saveDraft(storage, 'u1', 'c1', { a: 3 })
    saveDraft(storage, 'u1', 'c1', {})
    expect(storage.map.size).toBe(0)
  })

  it('throws away what is not a map of whole quantities', () => {
    expect(parseDraft(null)).toEqual({})
    expect(parseDraft('not json')).toEqual({})
    expect(parseDraft('[1,2]')).toEqual({})
    expect(parseDraft('{"a":-1,"b":1.5,"c":"4","d":2,"e":null}')).toEqual({ d: 2, e: null })
    const over = CountLimits.MAX_COUNTED_QUANTITY + 1
    expect(parseDraft(`{"a":${over},"b":${CountLimits.MAX_COUNTED_QUANTITY}}`)).toEqual({
      b: CountLimits.MAX_COUNTED_QUANTITY
    })
  })

  it('does not fail when the storage refuses', () => {
    const refusing: DraftStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    }
    expect(() => saveDraft(refusing, 'u1', 'c1', { a: 1 })).not.toThrow()
    expect(() => saveDraft(refusing, 'u1', 'c1', {})).not.toThrow()
    expect(loadDraft(refusing, 'u1', 'c1')).toEqual({})
  })

  it('keeps what was typed again while a request was in flight', () => {
    expect(withoutConfirmed({ a: 3, b: 5, c: null }, { a: 3, b: 4, c: null })).toEqual({ b: 5 })
  })

  it('drops the lines that are not on the sheet', () => {
    expect(onlyLinesOf({ a: 1, z: 2 }, new Set(['a']))).toEqual({ a: 1 })
  })

  it('cuts the draft in requests the api accepts, none of them empty', () => {
    expect(chunkEdits({}, 2)).toEqual([])
    expect(chunkEdits({ a: 1, b: 2, c: null }, 2)).toEqual([{ a: 1, b: 2 }, { c: null }])
    expect(chunkEdits({ a: 1 }, 500)).toEqual([{ a: 1 }])
  })
})
