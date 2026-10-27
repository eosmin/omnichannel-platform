import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import {
  PresenceStatus,
  PresenceTiming,
  RealtimeEvents,
  SocketLimits
} from '@platform/core/realtime'
import { REDIS_CLIENT } from '@platform/core/redis'

import { RealtimeService } from './realtime.service'

export interface UserPresence {
  userId: string
  status: PresenceStatus
}

// Adds a socket if the user has room for one.
// KEYS: 1 the sockets of the user, 2 the users of the store, 3 their last activity.
// ARGV: 1 the socket, 2 now, 3 the oldest heartbeat that is online, 4 the most sockets, 5 the expiry
// of the sockets, 6 the user, 7 the expiry of the activity, 8 the oldest heartbeat that still counts
// toward the cap (a silent socket is closed later than it stops being online), 9 '1' to set the
// last activity.
// Returns {1 if admitted or 0, how many were online before}.
const ADMIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[8])
local alive = redis.call('ZCOUNT', KEYS[1], ARGV[3], '+inf')
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) and not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return {0, alive}
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[5])
redis.call('SADD', KEYS[2], ARGV[6])
if ARGV[9] == '1' then redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[7]) end
return {1, alive}
`

// Refreshes a socket that is registered, and the user in the store. KEYS: the sockets of the user, the
// users of the store, their last activity. ARGV: the socket, now, the expiry of the sockets, the user,
// '1' if the user did something, the expiry of the activity. Returns 1, or 0 if the socket is not there.
const HEARTBEAT_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
if ARGV[5] == '1' then redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[6]) end
return 1
`

// Removes a socket and, if it was the last one alive, the user from the store: all in one step, so
// that a socket that connects at the same moment (a page reload) is either counted before or after,
// never lost in between. KEYS: the sockets of the user, the users of the store, their last activity.
// ARGV: the socket, the user, the oldest heartbeat the cap still counts (older ones are dropped), the
// oldest that is online. Returns 1 when the user left.
const DISCONNECT_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
if redis.call('ZCOUNT', KEYS[1], ARGV[4], '+inf') == 0 then
  redis.call('SREM', KEYS[2], ARGV[2])
  redis.call('DEL', KEYS[3])
  return 1
end
return 0
`

// Takes a user out of the store only if no socket of theirs is alive now: one that connected since
// the caller counted them stays. KEYS: the sockets of the user, the users of the store.
// ARGV: the user, the oldest heartbeat that still counts.
const FORGET_SCRIPT = `
if redis.call('ZCOUNT', KEYS[1], ARGV[2], '+inf') == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
end
return 0
`

const aliveAfter = (): number => Date.now() - PresenceTiming.SOCKET_TTL_SECONDS * 1000

// Presence is tracked per socket, so a user with two tabs stays online until the last socket of that
// store closes. The sockets of a user are a sorted set scored by their last heartbeat: a socket
// that stops heartbeating (a crashed instance, a lost network) stops counting after
// SOCKET_TTL_SECONDS on its own, and is dropped from the set by the next change.
@Injectable()
export class PresenceService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly realtime: RealtimeService
  ) {}

  // Lets a socket in, unless the user already has as many alive as a person has devices: counting and
  // adding are one step, so sockets that arrive together cannot all pass. A Redis that fails lets it
  // in: presence is best effort and must not turn people away.
  async admit(
    storeId: string,
    userId: string,
    socketId: string,
    // False for a socket let in again by a heartbeat: that is not the user doing something
    touchActivity = true
  ): Promise<{ admitted: boolean; wasOnline: boolean }> {
    try {
      const result = (await this.redis.eval(
        ADMIT_SCRIPT,
        3,
        CacheKeys.presence.sockets(storeId, userId),
        CacheKeys.presence.store(storeId),
        CacheKeys.presence.lastActivity(storeId, userId),
        socketId,
        Date.now(),
        aliveAfter(),
        SocketLimits.MAX_SOCKETS_PER_USER,
        SocketLimits.COUNTS_FOR_CAP_SECONDS,
        userId,
        PresenceTiming.ACTIVITY_TTL_SECONDS,
        Date.now() - SocketLimits.COUNTS_FOR_CAP_SECONDS * 1000,
        touchActivity ? '1' : '0'
      )) as [number, number]
      return { admitted: result[0] === 1, wasOnline: result[1] > 0 }
    } catch {
      return { admitted: true, wasOnline: true }
    }
  }

  // Tells the store that the user is here, when the socket that was admitted is their first
  announceOnline(storeId: string, userId: string): void {
    this.realtime.toStore(storeId, RealtimeEvents.USER_ONLINE, { userId })
  }

  async socketDisconnected(storeId: string, userId: string, socketId: string): Promise<void> {
    const left = await this.redis.eval(
      DISCONNECT_SCRIPT,
      3,
      CacheKeys.presence.sockets(storeId, userId),
      CacheKeys.presence.store(storeId),
      CacheKeys.presence.lastActivity(storeId, userId),
      socketId,
      userId,
      Date.now() - SocketLimits.COUNTS_FOR_CAP_SECONDS * 1000,
      aliveAfter()
    )
    if (left === 1) this.realtime.toStore(storeId, RealtimeEvents.USER_OFFLINE, { userId })
  }

  // The client sends one every 30 s while its socket is open, visible or not, so a background tab
  // stays online. `active` is the user doing something: only that moves them out of away. Only a
  // socket that is registered is refreshed: a heartbeat in flight when the socket closed must not
  // bring it back. False says it was not, and the caller decides whether to admit it again (a write
  // that was lost at connect time).
  async heartbeat(
    storeId: string,
    userId: string,
    socketId: string,
    active: boolean
  ): Promise<boolean> {
    const result = await this.redis.eval(
      HEARTBEAT_SCRIPT,
      3,
      CacheKeys.presence.sockets(storeId, userId),
      CacheKeys.presence.store(storeId),
      CacheKeys.presence.lastActivity(storeId, userId),
      socketId,
      Date.now(),
      SocketLimits.COUNTS_FOR_CAP_SECONDS,
      userId,
      active ? '1' : '0',
      PresenceTiming.ACTIVITY_TTL_SECONDS
    )
    return result === 1
  }

  async getStorePresence(storeId: string): Promise<UserPresence[]> {
    const members = await this.redis.smembers(CacheKeys.presence.store(storeId))
    if (members.length === 0) return []

    const cutoff = aliveAfter()
    const pipeline = this.redis.pipeline()
    for (const userId of members) {
      pipeline.zcount(CacheKeys.presence.sockets(storeId, userId), cutoff, '+inf')
      pipeline.get(CacheKeys.presence.lastActivity(storeId, userId))
    }
    const results = await pipeline.exec()

    const now = Date.now()
    const present: UserPresence[] = []
    const stale: string[] = []
    members.forEach((userId, index) => {
      const alive = Number(results?.[index * 2]?.[1] ?? 0)
      if (alive === 0) {
        stale.push(userId)
        return
      }
      const lastActivity = Number(results?.[index * 2 + 1]?.[1] ?? 0)
      const idleSeconds = (now - lastActivity) / 1000
      present.push({
        userId,
        status:
          idleSeconds > PresenceTiming.AWAY_AFTER_SECONDS
            ? PresenceStatus.AWAY
            : PresenceStatus.ONLINE
      })
    })
    // Self-heal after a crashed instance: its users stopped heartbeating without a disconnect
    if (stale.length > 0) {
      const forget = this.redis.pipeline()
      for (const userId of stale) {
        forget.eval(
          FORGET_SCRIPT,
          2,
          CacheKeys.presence.sockets(storeId, userId),
          CacheKeys.presence.store(storeId),
          userId,
          cutoff
        )
      }
      await forget.exec()
    }
    return present
  }
}
