import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { WebPushError } from 'web-push'
import { z } from 'zod'

import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  NotificationSeverity,
  NotificationTypes,
  PushLimits,
  type PushOutcome,
  PushOutcomes,
  type PushPayload
} from '@platform/core/notifications'

import { PushOutcomeWindow, refusalOutcomeOf } from './push-outcome'
import { buildPushPayload, pushLocale } from './push-payload'
import { WebPushGateway } from './web-push.gateway'

// rls-context: the notification of the person is read inside JobContext.forUser; the tables of the person (browsers, memberships) are global

const GONE: ReadonlySet<number> = new Set([HttpStatusCodes.NOT_FOUND, HttpStatusCodes.GONE])

const rowSchema = z.object({
  id: z.string(),
  type: z.enum(NotificationTypes),
  severity: z.enum(NotificationSeverity),
  messageKey: z.string(),
  params: z.unknown(),
  resourceId: z.string().nullable(),
  actionPath: z.string().nullable()
})

// A push that may be tried again: the push service is down or slow, or asked us to wait. Anything
// else (a key it refuses, a payload it finds too large) would fail the same way again.
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND'
])
// What web-push rejects with when the push service stalls past the timeout we gave it
const SOCKET_TIMEOUT = 'Socket timeout'

function isTransient(error: unknown): boolean {
  // A plain Error is the network when it carries a network code, or is the timeout of the request;
  // any other (keys the library refuses, a url it cannot parse, a certificate) fails the same way again
  if (!(error instanceof WebPushError)) {
    const code: unknown = Reflect.get(Object(error), 'code')
    const message = error instanceof Error ? error.message : ''
    return (typeof code === 'string' && NETWORK_CODES.has(code)) || message === SOCKET_TIMEOUT
  }
  return (
    error.statusCode === HttpStatusCodes.TOO_MANY_REQUESTS ||
    error.statusCode >= HttpStatusCodes.INTERNAL_SERVER_ERROR
  )
}

// Sends one notification to every browser its recipient registered (TDD_06 §7.1)
@Injectable()
export class WebPushSender {
  private readonly recent = new PushOutcomeWindow()

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly gateway: WebPushGateway,
    private readonly logger: PinoLogger,
    @InjectMetric(MetricNames.WEB_PUSH_ATTEMPTS) private readonly attempts: Counter<string>
  ) {
    this.logger.setContext(WebPushSender.name)
  }

  async send(userId: string, notificationId: string): Promise<void> {
    // No keys: nothing can be sent, and retrying will not add them
    if (!this.gateway.enabled) return this.skip(userId, notificationId, 'no_vapid_keys')

    // One short context of the person for everything the database says (their notification, their membership, their browsers); the push
    // services are called outside of it, and each write afterwards opens its own
    const read = await this.readOf(userId, notificationId)
    if (read === 'user_gone') return this.skip(userId, notificationId, 'user_gone')
    const { found, member, subscriptions } = read
    // Gone, or read in the app while the job waited: the push has no reason left
    if (found === null) return this.skip(userId, notificationId, 'notification_gone')
    if (found.readAt !== null) return this.skip(userId, notificationId, 'already_read')
    // The browser is the person's, not the store's: a push of a store they can no longer enter (a
    // suspended or removed member, queued before it happened) would still reach their screen
    if (member === 0) return this.skip(userId, notificationId, 'not_a_member')

    const parsed = rowSchema.safeParse(found)
    if (!parsed.success) throw new UnrecoverableError('the notification does not fit a push')
    if (subscriptions.length === 0) return this.skip(userId, notificationId, 'no_subscription')

    let payload: PushPayload
    try {
      payload = buildPushPayload(parsed.data, pushLocale(found.user.locale))
    } catch (error) {
      // A missing message or parameter will be missing when the job is tried again
      throw new UnrecoverableError(error instanceof Error ? error.message : 'no push text')
    }
    const body = JSON.stringify(payload)
    const urgent = payload.severity === NotificationSeverity.ERROR

    const outcomes = await Promise.all(
      subscriptions.map(async sub => {
        try {
          await this.gateway.send(sub, body, urgent)
        } catch (error) {
          return this.settle(sub.id, userId, notificationId, error)
        }
        // Bookkeeping: its failure must not turn a delivered push into a retry of every browser
        await this.jobContext
          .forUser(userId, () =>
            this.prisma.client.pushSubscription.updateMany({
              where: { id: sub.id, userId },
              data: { lastUsed: new Date(), refusedCount: 0, refusedNotificationId: null }
            })
          )
          .catch((error: unknown) =>
            this.logger.warn({ userId, err: String(error) }, 'lastUsed of a push was not saved')
          )
        this.note(PushOutcomes.DELIVERED)
        return 'sent' as const
      })
    )
    // Retried as a whole: a browser that already has it gets the same tag, which replaces the first
    if (outcomes.includes('retry')) throw new Error('a push service could not be reached')
  }

  private async readOf(userId: string, notificationId: string) {
    try {
      return await this.jobContext.forUser(userId, async () => {
        // Both ids, so a job that names someone else's notification pushes nothing
        const found = await this.prisma.client.notification.findFirst({
          where: { id: notificationId, userId },
          select: {
            id: true,
            storeId: true,
            type: true,
            severity: true,
            messageKey: true,
            params: true,
            resourceId: true,
            actionPath: true,
            readAt: true,
            user: { select: { locale: true } }
          }
        })
        const member =
          found === null
            ? 0
            : await this.prisma.client.membership.count({
                where: {
                  userId,
                  storeId: found.storeId,
                  status: MembershipStatus.ACTIVE,
                  revokedAt: null
                }
              })
        const subscriptions =
          found === null || member === 0
            ? []
            : await this.prisma.client.pushSubscription.findMany({ where: { userId } })
        return { found, member, subscriptions }
      })
    } catch (error) {
      // A person who was deleted while the job waited has nothing left to push to
      if (error instanceof JobContextGoneError) return 'user_gone' as const
      throw error
    }
  }

  // A push that is not sent for a reason that is not an error. Nothing of the person or the text goes in
  // the line: the ids and the reason are what a missing notification needs to be traced.
  private skip(userId: string, notificationId: string, reason: string): void {
    this.logger.info({ userId, notificationId, reason }, 'a web push was not sent')
  }

  // The counter is what the alert reads; the window is what tells a systemic 400 from a bad browser. Neither may fail a push.
  private note(outcome: PushOutcome): void {
    this.recent.record(outcome)
    try {
      this.attempts.inc({ outcome })
    } catch (error) {
      this.logger.warn({ err: String(error) }, 'a web push was not counted in the metric')
    }
  }

  private async settle(
    subscriptionId: string,
    userId: string,
    notificationId: string,
    error: unknown
  ): Promise<'dropped' | 'retry' | 'failed'> {
    if (error instanceof WebPushError && GONE.has(error.statusCode)) {
      this.note(PushOutcomes.GONE)
      // The browser unsubscribed or the push service forgot it: it never comes back
      try {
        await this.jobContext.forUser(userId, () =>
          this.prisma.client.pushSubscription.deleteMany({
            where: { id: subscriptionId, userId }
          })
        )
      } catch (deleteError) {
        // A person deleted meanwhile took their browsers with them: nothing to drop, and no reason to push the other browsers again
        if (!(deleteError instanceof JobContextGoneError)) throw deleteError
      }
      this.logger.info(
        {
          userId,
          notificationId,
          subscriptionId,
          statusCode: error.statusCode,
          reason: 'subscription_gone'
        },
        'a web push subscription was dropped: the browser or its push service forgot it'
      )
      return 'dropped'
    }
    const statusCode = error instanceof WebPushError ? error.statusCode : undefined
    if (isTransient(error)) {
      this.note(PushOutcomes.RETRY)
      this.logger.warn({ userId, statusCode, subscriptionId }, 'a web push was not delivered')
      return 'retry'
    }
    // The push service refused it for good (the VAPID keys, a payload): worth an alert (`platform_web_push_attempts_total`), not a retry
    const outcome = refusalOutcomeOf(error)
    this.note(outcome)
    // Only a 400 names this browser's own subscription (a keys or endpoint the service will not take). A 401, 403 or 413, an error
    // of the library or of the certificate says the server is misconfigured (a rotated or wrong VAPID key, no CA bundle, a payload
    // too big): counting those would empty every list of browsers after five pushes. Those stay an alert (`platform_web_push_attempts_total`).
    // A 400 too says nothing about the browser while this process delivers nothing at all (a payload or header every service rejects).
    if (outcome !== PushOutcomes.REFUSED_BAD_REQUEST) {
      this.logger.error({ userId, statusCode, subscriptionId }, 'a web push was refused')
    } else if (this.recent.serverLooksSound()) {
      this.logger.error({ userId, statusCode, subscriptionId }, 'a web push was refused')
      await this.countRefusal(subscriptionId, userId, notificationId)
    } else {
      this.logger.error(
        { userId, statusCode, subscriptionId, reason: 'refused_unproven' },
        'a web push was refused with a 400 and this process has delivered none lately: not counted against the browser'
      )
    }
    return 'failed'
  }

  // A browser that is refused for good again and again would stay in the list for ever: it is counted, once for each notification (a
  // retry of the job sends it again and must not count again), and dropped at the limit. The drop reads the count in its own
  // filter, so it never removes a browser that is under the limit; a refusal counted late only delays the drop by one push.
  // Bookkeeping: its failure changes nothing.
  private async countRefusal(
    subscriptionId: string,
    userId: string,
    notificationId: string
  ): Promise<void> {
    try {
      await this.jobContext.forUser(userId, async () => {
        await this.prisma.client.pushSubscription.updateMany({
          where: {
            id: subscriptionId,
            userId,
            OR: [
              { refusedNotificationId: null },
              { refusedNotificationId: { not: notificationId } }
            ]
          },
          data: { refusedCount: { increment: 1 }, refusedNotificationId: notificationId }
        })
        const dropped = await this.prisma.client.pushSubscription.deleteMany({
          where: { id: subscriptionId, userId, refusedCount: { gte: PushLimits.MAX_REFUSALS } }
        })
        if (dropped.count > 0) {
          this.logger.warn(
            { userId, subscriptionId, reason: 'refused_too_often' },
            'a web push subscription was dropped: its push service refused it for good again and again'
          )
        }
      })
    } catch (error) {
      if (error instanceof JobContextGoneError) return
      this.logger.warn({ userId, err: String(error) }, 'a refusal of a push was not counted')
    }
  }
}
