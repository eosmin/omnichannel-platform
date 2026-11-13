import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'

import { RedisCarrierTokenCache } from './redis-carrier-token-cache'

function redis(overrides: Partial<Record<'get' | 'set' | 'del', jest.Mock>> = {}): {
  client: Redis
  mocks: Record<'get' | 'set' | 'del', jest.Mock>
} {
  const mocks = {
    get: jest.fn().mockResolvedValue('token'),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ...overrides
  }
  return { client: mocks as unknown as Redis, mocks }
}

describe('RedisCarrierTokenCache', () => {
  it('keeps the token under the key of the store and the connection, with the time it lives', async () => {
    const { client, mocks } = redis()
    const cache = new RedisCarrierTokenCache(client)
    await cache.set('store-1', 'conn-1', 'token', 3600)
    expect(mocks.set).toHaveBeenCalledWith(
      CacheKeys.carrier.accessToken('store-1', 'conn-1'),
      'token',
      'EX',
      3600
    )
    expect(await cache.get('store-1', 'conn-1')).toBe('token')
    expect(mocks.get).toHaveBeenCalledWith(CacheKeys.carrier.accessToken('store-1', 'conn-1'))
    await cache.delete('store-1', 'conn-1')
    expect(mocks.del).toHaveBeenCalledWith(CacheKeys.carrier.accessToken('store-1', 'conn-1'))
  })

  it('puts the store in the key, so no store reads the token of another', () => {
    expect(CacheKeys.carrier.accessToken('store-1', 'conn-1')).toContain('store-1')
    expect(CacheKeys.carrier.accessToken('store-1', 'conn-1')).not.toBe(
      CacheKeys.carrier.accessToken('store-2', 'conn-1')
    )
  })

  it('does not stop a guide when Redis is down: a read answers no token and a write or a delete is dropped', async () => {
    const down = jest.fn().mockRejectedValue(new Error('redis down'))
    const cache = new RedisCarrierTokenCache(redis({ get: down, set: down, del: down }).client)
    expect(await cache.get('store-1', 'conn-1')).toBeNull()
    await expect(cache.set('store-1', 'conn-1', 'token', 60)).resolves.toBeUndefined()
    await expect(cache.delete('store-1', 'conn-1')).resolves.toBeUndefined()
  })
})
