import { createHash } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { UnsubscribeTokenThrottle } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import { UnsubscribeScopes, verifyUnsubscribeTokenUnderKeys } from '@platform/core/crypto'
import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { DigestFrequency } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { UNSUBSCRIBE_VERIFICATION_KEYS } from '@platform/core/notifications'
import { REDIS_CLIENT } from '@platform/core/redis'

// Why a request did not switch anything off, for the metric. Never part of the answer: every one of them is the same 204.
export const UnsubscribeRejections = {
  NO_TOKEN: 'no_token',
  INVALID: 'invalid',
  GONE: 'gone',
  RATE_LIMITED: 'rate_limited'
} as const

// Counts one more and answers the count, starting the window with the first
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`

// The one-click unsubscribe of the notification emails (Step 7.3, B6b-3b2b). PUBLIC (owner decision of 2026-11-23, recorded in IMPLEMENTATION_PLAN.md): the
// person has no session when they open the link of a mail, and the signed token is the credential.
//
// What it does is ONE thing: it sets the notification email of the person in the token to OFF, and takes off the marks of the emails that
// were waiting. It never turns anything on, never changes another choice, and doing it twice is the same as doing it once.
//
// Who it can touch: only the person the token names. The id is read from a token whose mac covers it, never from the body, so a changed id
// is a token that does not verify. The write runs in the context of that one person (`JobContext.forUser`: the stores they belong to and no
// other), so row level security still stands between this route and every other person's rows. There is no role that skips it here.
//
// What it says: nothing. A token that is altered, signed under another key, of a person who no longer exists or of a person already off
// all get the same 204, so the route cannot be used to find out who has an account. The only refusal is the rate limit, which counts every
// token alike (a good one and a junk one), so a 429 says nothing about the token either.
@Injectable()
export class NotificationUnsubscribeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobContext,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(UNSUBSCRIBE_VERIFICATION_KEYS) private readonly keys: readonly string[],
    @InjectMetric(MetricNames.NOTIFICATION_UNSUBSCRIBE_REJECTED)
    private readonly rejected: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(NotificationUnsubscribeService.name)
  }

  async unsubscribe(token: string | undefined): Promise<void> {
    if (token === undefined) {
      this.rejected.inc({ reason: UnsubscribeRejections.NO_TOKEN })
      return
    }
    // Counted BEFORE it is read, whatever it is: the limit of a token that does not exist is the same as one that does
    await this.countAgainstLimit(token)

    const verified = verifyUnsubscribeTokenUnderKeys(this.keys, token)
    if (verified?.scope !== UnsubscribeScopes.NOTIFICATION_EMAIL) {
      this.rejected.inc({ reason: UnsubscribeRejections.INVALID })
      return
    }
    try {
      const changed = await this.jobs.forUser(verified.id, () => this.switchOff(verified.id))
      if (changed) {
        // Ids only: no address, no name, no token (the audit log outlives the retention windows)
        this.audit.log({
          action: AuditAction.NOTIFICATION_EMAIL_UNSUBSCRIBED,
          actor: { userId: verified.id },
          resourceType: 'notification_email',
          resourceId: verified.id,
          metadata: { scope: verified.scope }
        })
      }
    } catch (error) {
      // A person who was deleted after the mail went out: the same answer as everyone else
      if (error instanceof JobContextGoneError) {
        this.rejected.inc({ reason: UnsubscribeRejections.GONE })
        return
      }
      throw error
    }
  }

  // True when the person was not already off. The marks of the waiting emails go either way: a person who is off has none that matter
  private async switchOff(userId: string): Promise<boolean> {
    const before = await this.prisma.client.userNotificationSettings.findUnique({
      where: { userId },
      select: { digestFrequency: true }
    })
    await this.prisma.client.userNotificationSettings.upsert({
      where: { userId },
      create: { userId, digestFrequency: DigestFrequency.OFF },
      update: { digestFrequency: DigestFrequency.OFF }
    })
    // The marks of every store the person belongs to (the context of `forUser` is exactly those stores)
    await this.prisma.client.notification.updateMany({
      where: { userId, emailPendingAt: { not: null } },
      data: { emailPendingAt: null }
    })
    return before?.digestFrequency !== DigestFrequency.OFF
  }

  private async countAgainstLimit(token: string): Promise<void> {
    // The hash of the token, never the token: a key of Redis travels in dumps and monitors
    const key = CacheKeys.unsubscribe.tokenWindow(createHash('sha256').update(token).digest('hex'))
    const count = Number(
      await this.redis.eval(COUNT_SCRIPT, 1, key, String(UnsubscribeTokenThrottle.ttlMs))
    )
    if (count > UnsubscribeTokenThrottle.limit) {
      this.rejected.inc({ reason: UnsubscribeRejections.RATE_LIMITED })
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'too many requests',
        HttpStatusCodes.TOO_MANY_REQUESTS
      )
    }
  }
}
