import { createHash } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  dsrEmailHash,
  sealDsrIntake
} from '@platform/core/compliance'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { type DsrIntakeJob, JobNames, QueueNames } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'

import type { DsrIntakeBody } from './compliance.schemas'

const SECONDS_PER_DAY = 86_400

// Counts one more and answers the count, starting the day's clock with the first
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`

// What the public form of data requests (TDD_05 §10.2) answers, always: the same body whether or not the address belongs to a customer,
// the store key is known, the request repeats another or the form is off. Nothing here says which.
export interface DsrIntakeAnswer {
  accepted: true
}
const ACCEPTED: DsrIntakeAnswer = { accepted: true }

// The first half of a public data request. It does NOT look at customers: it counts (always, with or without a match, so a 429 says
// nothing about the address), seals what the person typed and hands it to the worker, which looks the address up and writes the
// request and the mail. The only refusal is the limit, which counts everyone alike.
@Injectable()
export class DsrIntakeService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<DsrIntakeJob>,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig
  ) {}

  async submit(body: DsrIntakeBody): Promise<DsrIntakeAnswer> {
    // Off: the same answer, nothing written, nothing counted, nothing queued
    if (!this.config.enabled) return ACCEPTED

    const day = new Date().toISOString().slice(0, 10)
    const byEmail = await this.count(
      CacheKeys.dsr.intakeEmailDay(dsrEmailHash(body.email, this.config.hashKey), day)
    )
    const byStore = await this.count(
      CacheKeys.dsr.intakeStoreDay(createHash('sha256').update(body.storeKey).digest('hex'), day)
    )
    if (
      byEmail > ComplianceConfig.DSR_INTAKE_PER_EMAIL_PER_DAY ||
      byStore > ComplianceConfig.DSR_INTAKE_PER_STORE_PER_DAY
    ) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'too many requests',
        HttpStatusCodes.TOO_MANY_REQUESTS,
        // At most a day: the counters last a day from their first count. Not the exact time, so that the answer is the same
        // for the address and for the store (a 429 says nothing about which of them was over)
        { [RETRY_AFTER_METADATA_KEY]: SECONDS_PER_DAY }
      )
    }

    // No job id, and a name with no data in it: the address must not reach Redis in the clear, in a key or in a payload. The payload
    // is sealed and the job is gone after an hour, done or not.
    await this.queue.add(
      JobNames.DSR_INTAKE,
      { sealed: sealDsrIntake(body, this.config.encryptionKeyHex) },
      {
        removeOnComplete: true,
        removeOnFail: { age: ComplianceConfig.DSR_INTAKE_JOB_TTL_MS / 1000 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 }
      }
    )
    return ACCEPTED
  }

  private async count(key: string): Promise<number> {
    const reply = await this.redis.eval(COUNT_SCRIPT, 1, key, String(SECONDS_PER_DAY))
    return typeof reply === 'number' ? reply : Number.POSITIVE_INFINITY
  }
}
