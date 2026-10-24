import { API_PREFIX } from './api-prefix'
import { StorageKeys } from './storage-keys'

describe('browser constants', () => {
  it('prefixes the API once, without a trailing slash', () => {
    expect(API_PREFIX).toBe('/api/v1')
  })

  it('namespaces every localStorage key and keeps them unique', () => {
    const keys: string[] = Object.values(StorageKeys)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key.startsWith('platform_')).toBe(true)
  })
})
