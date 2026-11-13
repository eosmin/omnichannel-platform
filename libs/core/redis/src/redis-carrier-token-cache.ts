import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import type { CarrierTokenCache } from '@platform/core/domain'

// The token cache of the carrier plugins on Redis. A Redis that is down must not stop a guide from being made: a read that
// fails answers "no token" (the plugin asks the carrier for one) and a write that fails is dropped (the next call asks again).
export class RedisCarrierTokenCache implements CarrierTokenCache {
  constructor(private readonly redis: Redis) {}

  async get(storeId: string, connectionId: string): Promise<string | null> {
    try {
      return await this.redis.get(CacheKeys.carrier.accessToken(storeId, connectionId))
    } catch {
      return null
    }
  }

  async set(
    storeId: string,
    connectionId: string,
    token: string,
    ttlSeconds: number
  ): Promise<void> {
    try {
      await this.redis.set(
        CacheKeys.carrier.accessToken(storeId, connectionId),
        token,
        'EX',
        ttlSeconds
      )
    } catch {
      // The token is only a copy of what the carrier would give again
    }
  }

  async delete(storeId: string, connectionId: string): Promise<void> {
    try {
      await this.redis.del(CacheKeys.carrier.accessToken(storeId, connectionId))
    } catch {
      // It expires by itself
    }
  }
}
