import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import { RemoteChannelApiLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'

// INCRBY and the window in one step, so that two requests at once cannot leave a counter with no end.
//   KEYS[1] the counter   ARGV[1] how many   ARGV[2] window seconds
// Returns the count after adding and the seconds the window has left
const COUNT_SCRIPT = `
local n = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
  ttl = tonumber(ARGV[2])
end
return {n, ttl}
`

// The two limits of the events of a remote channel plugin that live in Redis (TDD_10 §6.7.5): the ceiling of events a minute of
// the whole installation (on top of the requests a minute of its key, which the guard counts), and the gap between two
// `customer_typing` of one conversation. The ceiling fails closed (a limit that is open when its store fails is no limit); the typing
// gap fails soft, because a typing is a courtesy and passing none loses nothing.
@Injectable()
export class PluginChannelLimitsStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Counts `events` more for this installation in the current minute; past the ceiling the answer is 429 with Retry-After
  async takeEvents(installationId: string, events: number): Promise<void> {
    let reply: unknown
    try {
      reply = await this.redis.eval(
        COUNT_SCRIPT,
        1,
        CacheKeys.plugin.channelEventsWindow(installationId),
        String(events),
        String(RemoteChannelApiLimits.EVENTS_WINDOW_SECONDS)
      )
    } catch {
      throw unavailable()
    }
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
      throw unavailable()
    }
    const [count, secondsLeft] = reply as [number, number]
    if (count > RemoteChannelApiLimits.MAX_EVENTS_PER_MINUTE) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'the plugin is over its ceiling of events a minute',
        HttpStatusCodes.TOO_MANY_REQUESTS,
        { [RETRY_AFTER_METADATA_KEY]: Math.max(1, secondsLeft) }
      )
    }
  }

  // True when this typing may be passed on (the first of its conversation in the last 2 seconds)
  async takeTyping(conversationId: string): Promise<boolean> {
    try {
      const set = await this.redis.set(
        CacheKeys.plugin.channelTyping(conversationId),
        '1',
        'PX',
        RemoteChannelApiLimits.TYPING_GAP_MS,
        'NX'
      )
      return set === 'OK'
    } catch {
      // A typing is a courtesy: when Redis is down it is not passed on, and nothing else is lost
      return false
    }
  }
}

function unavailable(): PlatformException {
  return new PlatformException(
    ErrorCodes.INTERNAL_ERROR,
    'the plugin API is not available right now',
    HttpStatusCodes.SERVICE_UNAVAILABLE
  )
}
