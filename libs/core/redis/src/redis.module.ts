import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown
} from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { Redis } from 'ioredis'

import { MetricNames } from '@platform/core/metrics'
import { getMetricToken } from '@platform/core/metrics-module'

import { CacheService } from './cache.service'

export const REDIS_CLIENT = Symbol('REDIS_CLIENT')

export interface RedisModuleOptions {
  url: string
}

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'end') return
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect() // quit() rejects when the connection is already down
    }
  }
}

// The client of the cache, the leader locks and the readiness probe, and the CacheService on it.
// The queues open their own connections (they need maxRetriesPerRequest: null, which a
// request-reply client must not have).
@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        {
          provide: REDIS_CLIENT,
          useFactory: (): Redis => {
            // TLS is implied by rediss://. This client is on the path of every request (the cache of
            // the tenant, the rate limit), so a Redis that is down has to fail a command fast and let
            // the caller go to the source: ioredis waits 73 seconds by default (20 retries), which
            // would hang every request of the platform. One retry fails in about 120 ms, and a
            // Redis that is up but stuck is cut at half a second.
            const client = new Redis(options.url, { maxRetriesPerRequest: 1, commandTimeout: 500 })
            const logger = new Logger('Redis')
            // Without a listener ioredis would throw the connection errors as uncaught exceptions
            client.on('error', error => logger.error(`redis connection error: ${error.message}`))
            return client
          }
        },
        {
          provide: CacheService,
          // The counters are optional: a test or a process without the metrics module still caches
          inject: [
            REDIS_CLIENT,
            { token: getMetricToken(MetricNames.CACHE_HITS), optional: true },
            { token: getMetricToken(MetricNames.CACHE_MISSES), optional: true }
          ],
          useFactory: (
            client: Redis,
            hits: Counter<string> | undefined,
            misses: Counter<string> | undefined
          ): CacheService =>
            new CacheService(client, {
              onHit: namespace => hits?.inc({ namespace }),
              onMiss: namespace => misses?.inc({ namespace })
            })
        },
        RedisShutdown
      ],
      exports: [REDIS_CLIENT, CacheService]
    }
  }
}
