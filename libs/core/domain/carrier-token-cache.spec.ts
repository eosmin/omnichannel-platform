import { MemoryCarrierTokenCache } from './carrier-token-cache'

describe('MemoryCarrierTokenCache', () => {
  afterEach(() => jest.useRealTimers())

  it('keeps a token for a connection of a store and for no other', async () => {
    const cache = new MemoryCarrierTokenCache()
    await cache.set('store-1', 'conn-1', 'token', 60)
    expect(await cache.get('store-1', 'conn-1')).toBe('token')
    expect(await cache.get('store-2', 'conn-1')).toBeNull()
    expect(await cache.get('store-1', 'conn-2')).toBeNull()
  })

  it('forgets a token when it expires', async () => {
    jest.useFakeTimers()
    const cache = new MemoryCarrierTokenCache()
    await cache.set('store-1', 'conn-1', 'token', 60)
    jest.advanceTimersByTime(59_000)
    expect(await cache.get('store-1', 'conn-1')).toBe('token')
    jest.advanceTimersByTime(2_000)
    expect(await cache.get('store-1', 'conn-1')).toBeNull()
  })

  it('forgets a token that is deleted', async () => {
    const cache = new MemoryCarrierTokenCache()
    await cache.set('store-1', 'conn-1', 'token', 60)
    await cache.delete('store-1', 'conn-1')
    expect(await cache.get('store-1', 'conn-1')).toBeNull()
  })
})
