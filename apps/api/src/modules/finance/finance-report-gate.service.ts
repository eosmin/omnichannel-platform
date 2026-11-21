import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { CacheKeys } from '@platform/core/cache'
import { JobContext } from '@platform/core/database'
import { FinanceReportLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'

// One place of the cap is a member of a sorted set scored by its last sign of life. Each script is one step for Redis, so two reports that
// ask at the same moment cannot both take the last place.
//   KEYS[1] the places of the organization
//   ARGV: 1 token, 2 now (ms), 3 oldest sign of life that still counts, 4 the most places, 5 expiry of the set (ms)
// Returns 1 when the place is taken, 0 when the organization is full.
const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`

// A sign of life: only a place that is still ours is renewed (one that expired is not brought back over the cap)
//   ARGV: 1 token, 2 now (ms), 3 expiry of the set (ms)
const RENEW_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`

interface HeldPlace {
  organizationId: string
  token: string
  // False when Redis could not be reached: there is no place to renew or to release
  taken: boolean
}

// The cap of the reports of Finance that one organization reads at once (TDD_18 §10; Step 7.3, debt (f) of F6-3 "finance reports of the
// whole organization"), and the unit in which each page of a report runs.
//
// A report is a series of short units of the organization, one per page, inside ONE place of the cap: `read` takes the place (or refuses
// with FINANCE_REPORT_BUSY) and gives it back in `finally`; `unit` opens one page's unit and renews the place. A report that calls
// another (the CSV of the VAT report reads the report) joins the place it already holds, so one request never takes two.
//
// If Redis cannot be reached the report runs without the cap and says so in the log: the cap protects the database pool, and the reports
// only read, so losing the cap for a moment is better than losing every report. The place of a process that died is dropped by its expiry.
@Injectable()
export class FinanceReportGate {
  private readonly held = new AsyncLocalStorage<HeldPlace>()

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly jobContext: JobContext,
    private readonly logger: PinoLogger
  ) {}

  // Runs a whole report inside a place of the organization. The callback must open its own units with `unit`
  async read<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const open = this.held.getStore()
    if (open?.organizationId === organizationId) return work()
    const token = randomUUID()
    const taken = await this.acquire(organizationId, token)
    try {
      return await this.held.run({ organizationId, token, taken }, work)
    } finally {
      if (taken) await this.release(organizationId, token)
    }
  }

  // One page of a report: a unit of the organization with its own timeout, and a sign of life for the place
  async unit<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    const open = this.held.getStore()
    if (open?.organizationId === organizationId && open.taken) {
      // A place that expired meanwhile (a stalled process) is taken again, or the page is refused if the organization filled up: the cap is
      // never exceeded by a report that outlived its place
      if (!(await this.renew(organizationId, open.token))) {
        await this.acquire(organizationId, open.token)
      }
    }
    return this.jobContext.inOrganization(organizationId, work, {
      timeout: FinanceReportLimits.READ_UNIT_TIMEOUT_MS
    })
  }

  private async acquire(organizationId: string, token: string): Promise<boolean> {
    const now = Date.now()
    let granted: unknown
    try {
      granted = await this.redis.eval(
        ACQUIRE_SCRIPT,
        1,
        CacheKeys.financeReports.readSlots(organizationId),
        token,
        now,
        now - FinanceReportLimits.READ_SLOT_TTL_MS,
        FinanceReportLimits.MAX_CONCURRENT_READS_PER_ORGANIZATION,
        FinanceReportLimits.READ_SLOT_TTL_MS
      )
    } catch (error) {
      this.logger.warn(
        { organizationId, errorName: error instanceof Error ? error.name : 'unknown' },
        'the cap of finance report reads could not be checked; the report runs without it'
      )
      return false
    }
    if (Number(granted) !== 1) {
      throw new PlatformException(
        ErrorCodes.FINANCE_REPORT_BUSY,
        'the organization is already reading as many finance reports as it may at once',
        HttpStatusCodes.TOO_MANY_REQUESTS,
        { retryAfterSeconds: FinanceReportLimits.READ_BUSY_RETRY_SECONDS }
      )
    }
    return true
  }

  private async renew(organizationId: string, token: string): Promise<boolean> {
    try {
      const kept = await this.redis.eval(
        RENEW_SCRIPT,
        1,
        CacheKeys.financeReports.readSlots(organizationId),
        token,
        Date.now(),
        FinanceReportLimits.READ_SLOT_TTL_MS
      )
      return Number(kept) === 1
    } catch (error) {
      // A missed sign of life only lets the place expire sooner; the page still runs
      this.logger.warn(
        { organizationId, errorName: error instanceof Error ? error.name : 'unknown' },
        'a place of the finance report cap could not be renewed'
      )
      return true
    }
  }

  private async release(organizationId: string, token: string): Promise<void> {
    try {
      await this.redis.zrem(CacheKeys.financeReports.readSlots(organizationId), token)
    } catch (error) {
      // The expiry drops it
      this.logger.warn(
        { organizationId, errorName: error instanceof Error ? error.name : 'unknown' },
        'a place of the finance report cap could not be released; it expires on its own'
      )
    }
  }
}
