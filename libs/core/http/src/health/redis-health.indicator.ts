import { Inject, Injectable } from '@nestjs/common'
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus'
import type { Redis } from 'ioredis'

import { REDIS_CLIENT } from '@platform/core/redis'

const DEFAULT_TIMEOUT_MS = 2000

@Injectable()
export class RedisHealthIndicator {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly indicators: HealthIndicatorService
  ) {}

  // A PING over the connection the cache and the locks use
  isHealthy(key: string, options: { timeoutMs?: number } = {}): PromiseLike<HealthIndicatorResult> {
    return this.indicators
      .check(key)
      .attempt(async () => {
        await this.redis.ping()
      })
      .withTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }
}
