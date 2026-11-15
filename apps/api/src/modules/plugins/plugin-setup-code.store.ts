import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import { CacheKeys } from '@platform/core/cache'
import { generateToken, hashToken } from '@platform/core/crypto'
import { PluginInstallLimits } from '@platform/core/domain'
import { REDIS_CLIENT } from '@platform/core/redis'

// What a live code stands for: the installation and its store. Nothing secret, and never the key (the key does not exist yet).
const recordSchema = z.strictObject({ installationId: z.uuid(), storeId: z.uuid() })
export type SetupCodeRecord = z.output<typeof recordSchema>

export interface IssuedSetupCode {
  code: string
  expiresAt: Date
}

// Each operation is one Lua script, so that two calls at once cannot interleave: a code and the pointer of its installation are
// written, replaced and removed together.
//   KEYS[1] the pointer of the installation   KEYS[2] the code that is being made
//   ARGV[1] the prefix of code keys           ARGV[2] digest of the new code   ARGV[3] record   ARGV[4] ttl seconds
const ISSUE_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if previous then redis.call('DEL', ARGV[1] .. previous) end
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[4]))
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[4]))
return 1
`
//   KEYS[1] the code   ARGV[1] the prefix of pointer keys
// Returns the record that was read, after removing the code and the pointer it was found by
const TAKE_SCRIPT = `
local raw = redis.call('GETDEL', KEYS[1])
if not raw then return false end
local ok, record = pcall(cjson.decode, raw)
if ok and type(record) == 'table' and record['installationId'] then
  redis.call('DEL', ARGV[1] .. record['installationId'])
end
return raw
`
//   KEYS[1] the pointer   ARGV[1] the prefix of code keys
const VOID_SCRIPT = `
local digest = redis.call('GETDEL', KEYS[1])
if digest then redis.call('DEL', ARGV[1] .. digest) end
return 1
`

// The one-time code of an install (TDD_10 §6.3): 256 bits, five minutes, used once. It lives in Redis only, under the SHA-256
// of the code, so a copy of Redis holds no code that still works. One installation has one live code: a new one voids the old.
// A value that does not parse is a value nobody here wrote, and reads as missing.
@Injectable()
export class PluginSetupCodeStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async issue(record: SetupCodeRecord): Promise<IssuedSetupCode> {
    const code = generateToken(PluginInstallLimits.SETUP_CODE_BYTES)
    const digest = hashToken(code)
    const ttl = PluginInstallLimits.SETUP_CODE_TTL_SECONDS
    const expiresAt = new Date(Date.now() + ttl * 1000)
    await this.redis.eval(
      ISSUE_SCRIPT,
      2,
      CacheKeys.plugin.setupCodeOf(record.installationId),
      CacheKeys.plugin.setupCode(digest),
      CacheKeys.plugin.setupCode(''),
      digest,
      JSON.stringify(record),
      ttl
    )
    return { code, expiresAt }
  }

  // Read and removed in one command: two exchanges with the same code cannot both get it
  async take(code: string): Promise<SetupCodeRecord | null> {
    const raw = await this.redis.eval(
      TAKE_SCRIPT,
      1,
      CacheKeys.plugin.setupCode(hashToken(code)),
      CacheKeys.plugin.setupCodeOf('')
    )
    if (typeof raw !== 'string') return null
    try {
      const parsed = recordSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  // The installation was revoked or installed again: its code, if any, stops working
  async void(installationId: string): Promise<void> {
    await this.redis.eval(
      VOID_SCRIPT,
      1,
      CacheKeys.plugin.setupCodeOf(installationId),
      CacheKeys.plugin.setupCode('')
    )
  }
}
