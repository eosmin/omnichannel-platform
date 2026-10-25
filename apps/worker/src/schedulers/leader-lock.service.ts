import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import { REDIS_CLIENT } from '@platform/core/redis'

// Compare-and-delete: a replica that overran its TTL cannot delete a lock another replica now holds
const RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`

// The worker runs 1 to 5 replicas and every @Cron body runs inside withLock, so exactly one replica
// executes a given schedule (TDD_07 §4).
@Injectable()
export class LeaderLockService {
  private readonly instanceId = randomUUID()

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Returns false when another replica holds the lock, and true after running fn
  async withLock(name: string, ttlSeconds: number, fn: () => Promise<void>): Promise<boolean> {
    const key = CacheKeys.lock(name)
    const acquired = await this.redis.set(key, this.instanceId, 'EX', ttlSeconds, 'NX')
    if (acquired !== 'OK') return false
    try {
      await fn()
    } finally {
      // A failed release must not replace the error of fn; the lock expires by its TTL anyway
      await this.redis.eval(RELEASE_SCRIPT, 1, key, this.instanceId).catch(() => undefined)
    }
    return true
  }
}
