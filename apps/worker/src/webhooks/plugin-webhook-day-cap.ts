import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import { WebhookLimits } from '@platform/core/domain'
import { REDIS_CLIENT } from '@platform/core/redis'

// One step in Redis, so that two deliveries at the same instant cannot both pass the last place: the window is cleared of what is
// older than a day, a delivery already counted passes again (the same job run twice is one delivery), the cap closes the door, and
// otherwise the delivery takes its place and the key is given a life of one window.
//   KEYS[1] the sorted set   ARGV[1] now (ms)   ARGV[2] window (ms)   ARGV[3] cap   ARGV[4] delivery id
// Returns 1 when the delivery may start, 0 when the cap of the window is reached
const TAKE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZSCORE', KEYS[1], ARGV[4]) then
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]), ARGV[4])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`

// The cap of deliveries a day that a plugin declares in its manifest (`limits.maxWebhooksPerDay`, TDD_10 §6.5), counted over the
// last 24 hours of one installation. The count and the place are one atomic step, so the cap holds under any number of workers.
// It fails closed: when Redis cannot be reached the error is thrown and the queue tries the job again, because a limit that is open
// when its store fails is no limit.
@Injectable()
export class PluginWebhookDayCap {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // True when this delivery may start (it took one of the places of the last 24 hours, or already held one)
  async take(
    installationId: string,
    deliveryId: string,
    cap: number,
    nowMs: number
  ): Promise<boolean> {
    const reply = await this.redis.eval(
      TAKE_SCRIPT,
      1,
      CacheKeys.plugin.webhookDay(installationId),
      String(nowMs),
      String(WebhookLimits.PLUGIN_DAY_MS),
      String(cap),
      deliveryId
    )
    if (reply !== 0 && reply !== 1)
      throw new Error('the cap of webhooks a day gave an unreadable answer')
    return reply === 1
  }
}
