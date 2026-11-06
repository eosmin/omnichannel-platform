import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import { CacheKeys } from '@platform/core/cache'
import { hashToken } from '@platform/core/crypto'
import { ChannelOAuthLimits } from '@platform/core/domain'
import { REDIS_CLIENT } from '@platform/core/redis'

// Who started a login: the user, the store of the request that started it, the plugin and, for a repair, the
// connection. Nothing secret.
const stateSchema = z.strictObject({
  userId: z.string().min(1),
  storeId: z.string().min(1),
  pluginId: z.string().min(1),
  // The connection this login repairs, when it was started from one: it travels here and never in an address
  connectionId: z.uuid().optional()
})
export type OAuthStateRecord = z.output<typeof stateSchema>

// The same three, and the token of the person sealed with the cipher of the credentials (base64)
const sessionSchema = stateSchema.extend({ sealed: z.string().min(1) })
export type OAuthSessionRecord = z.output<typeof sessionSchema>

// The state and the session live in Redis only, under the SHA-256 of the value the browser holds, so a copy
// of Redis holds no address that still works. They are not tenant keys: the callback arrives from the
// provider with no store, so the store is in the value. A value that does not parse is a value nobody
// here wrote, and reads as missing.
@Injectable()
export class ChannelOAuthStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async saveState(state: string, record: OAuthStateRecord): Promise<void> {
    await this.redis.set(
      CacheKeys.channel.oauthState(hashToken(state)),
      JSON.stringify(record),
      'EX',
      ChannelOAuthLimits.STATE_TTL_SECONDS
    )
  }

  // Read and removed in one command: two callbacks with the same state cannot both get it
  async takeState(state: string): Promise<OAuthStateRecord | null> {
    const raw = await this.redis.getdel(CacheKeys.channel.oauthState(hashToken(state)))
    return parse(stateSchema, raw)
  }

  async saveSession(sessionId: string, record: OAuthSessionRecord): Promise<void> {
    await this.redis.set(
      CacheKeys.channel.oauthSession(hashToken(sessionId)),
      JSON.stringify(record),
      'EX',
      ChannelOAuthLimits.SESSION_TTL_SECONDS
    )
  }

  async readSession(sessionId: string): Promise<OAuthSessionRecord | null> {
    const raw = await this.redis.get(CacheKeys.channel.oauthSession(hashToken(sessionId)))
    return parse(sessionSchema, raw)
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.redis.del(CacheKeys.channel.oauthSession(hashToken(sessionId)))
  }
}

function parse<T extends z.ZodType>(schema: T, raw: string | null): z.output<T> | null {
  if (raw === null) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
