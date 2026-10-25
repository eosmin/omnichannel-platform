import { Inject, Injectable } from '@nestjs/common'
import type { ThrottlerStorage } from '@nestjs/throttler'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import { CacheKeys } from '@platform/core/cache'

import { REDIS_CLIENT } from './redis.module'

// One round trip and atomic, so two replicas counting the same client never lose a hit.
//   KEYS[1] hits of the window     KEYS[2] marker of a block
//   ARGV[1] window ms   ARGV[2] limit   ARGV[3] block ms (0 = no block, only the window)
// Replies {hits, ms to the end of the window, blocked (0 or 1), ms to the end of the block}.
// The request that passes the limit is the first one refused, as in the in-memory storage of
// @nestjs/throttler; while a block lasts, further requests are refused without counting.
const INCREMENT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return {hits, math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockTtl}
end
local hits = redis.call('INCR', KEYS[1])
local windowMs = tonumber(ARGV[1])
if hits == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], windowMs)
end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  local blockMs = tonumber(ARGV[3])
  if blockMs > 0 then
    redis.call('SET', KEYS[2], '1', 'PX', blockMs)
    return {hits, ttl, 1, blockMs}
  end
  return {hits, ttl, 1, ttl}
end
return {hits, ttl, 0, 0}
`

const replySchema = z.tuple([z.number(), z.number(), z.number(), z.number()])

const MS_PER_SECOND = 1000

// ThrottlerStorageRecord is not exported by the package: take it from the interface that is
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>

// The counters of the rate limits, in the Redis that every replica shares: in memory, each replica
// would keep its own and a client could spread its requests across them (TDD_05 section 3.1).
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = CacheKeys.rateLimit(throttlerName, key)
    const reply = await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      hitsKey,
      `${hitsKey}:block`,
      ttl,
      limit,
      blockDuration
    )
    const [totalHits, windowMs, blocked, blockMs] = replySchema.parse(reply)
    return {
      totalHits,
      timeToExpire: Math.ceil(windowMs / MS_PER_SECOND),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.ceil(blockMs / MS_PER_SECOND)
    }
  }
}
