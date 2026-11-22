import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'

import { PluginApiKeyProbeThrottle } from '@platform/core/auth'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { RedisThrottlerStorage } from '@platform/core/redis'

import { USER_RATE_LIMIT_STORAGE } from './user-rate-limit.guard'

// The per-address limit on the keys of the plugin API that do not open the door (PluginApiKeyProbeThrottle). It is asked BEFORE
// the key is looked up and before the large body of the events route is read, and it is fed only by the failures, so a plugin with a
// good key is not counted against it. Like the other limits of the address it is a protection and not a dependency: when Redis
// fails the call goes on (a key has 256 bits and the limit of the installation still holds) and the failure is logged.
@Injectable()
export class PluginKeyProbeLimiter {
  private readonly logger = new Logger(PluginKeyProbeLimiter.name)

  constructor(
    @Inject(USER_RATE_LIMIT_STORAGE) private readonly storage: RedisThrottlerStorage,
    @InjectMetric(MetricNames.RATE_LIMIT_HITS) private readonly hits: Counter<string>
  ) {}

  // Seconds that the address has to wait (0 when it is free). Counted in the metric when it is refused, by throttler and never by
  // address
  async retryAfter(address: string): Promise<number> {
    // No address (Express could not tell) has no counter of its own: it would be one for every caller that has none, and one
    // misconfigured proxy would turn the limit into a switch for the whole plugin API. The limit of the installation still holds.
    if (address === '') return 0
    try {
      return await this.storage.blockedFor(address, PluginApiKeyProbeThrottle.name)
    } catch (error) {
      this.failed(error)
      return 0
    }
  }

  countRefusal(): void {
    this.hits.inc({ throttler: PluginApiKeyProbeThrottle.name })
  }

  // A key of this address did not open the door
  async recordFailure(address: string): Promise<void> {
    if (address === '') return
    try {
      await this.storage.increment(
        address,
        PluginApiKeyProbeThrottle.ttlMs,
        PluginApiKeyProbeThrottle.limit,
        PluginApiKeyProbeThrottle.ttlMs,
        PluginApiKeyProbeThrottle.name
      )
    } catch (error) {
      this.failed(error)
    }
  }

  private failed(error: unknown): void {
    this.logger.error(
      `plugin key probe limit storage failed, letting the call through: ${error instanceof Error ? error.message : 'unknown error'}`
    )
  }
}
