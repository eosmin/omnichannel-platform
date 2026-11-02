import { Injectable } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { WebPushError } from 'web-push'
import { z } from 'zod'

import { PrismaService } from '@platform/core/database'
import { HttpStatusCodes } from '@platform/core/errors'
import {
  NotificationSeverity,
  NotificationTypes,
  type PushPayload
} from '@platform/core/notifications'

import { buildPushPayload, pushLocale } from './push-payload'
import { WebPushGateway } from './web-push.gateway'

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: WebPushGateway,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(WebPushSender.name)
  }

  async send(userId: string, notificationId: string): Promise<void> {
    if (!this.gateway.enabled) return // No keys: nothing can be sent, and retrying will not add them

    // Both ids, so a job that names someone else's notification pushes nothing
    const found = await this.prisma.client.notification.findFirst({
      where: { id: notificationId, userId },
      select: {
        id: true,
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
    // Gone, or read in the app while the job waited: the push has no reason left
    if (found === null || found.readAt !== null) return

    const parsed = rowSchema.safeParse(found)
    if (!parsed.success) throw new UnrecoverableError('the notification does not fit a push')
    const subscriptions = await this.prisma.client.pushSubscription.findMany({ where: { userId } })
    if (subscriptions.length === 0) return

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
          return this.settle(sub.id, userId, error)
        }
        // Bookkeeping: its failure must not turn a delivered push into a retry of every browser
        await this.prisma.client.pushSubscription
          .updateMany({ where: { id: sub.id }, data: { lastUsed: new Date() } })
          .catch((error: unknown) =>
            this.logger.warn({ userId, err: String(error) }, 'lastUsed of a push was not saved')
          )
        return 'sent' as const
      })
    )
    // Retried as a whole: a browser that already has it gets the same tag, which replaces the first
    if (outcomes.includes('retry')) throw new Error('a push service could not be reached')
  }

  private async settle(
    subscriptionId: string,
    userId: string,
    error: unknown
  ): Promise<'dropped' | 'retry' | 'failed'> {
    if (error instanceof WebPushError && GONE.has(error.statusCode)) {
      // The browser unsubscribed or the push service forgot it: it never comes back
      await this.prisma.client.pushSubscription.deleteMany({
        where: { id: subscriptionId, userId }
      })
      return 'dropped'
    }
    const statusCode = error instanceof WebPushError ? error.statusCode : undefined
    if (isTransient(error)) {
      this.logger.warn({ userId, statusCode, subscriptionId }, 'a web push was not delivered')
      return 'retry'
    }
    // The push service refused it for good (the VAPID keys, a payload): worth an alert, not a retry
    this.logger.error({ userId, statusCode, subscriptionId }, 'a web push was refused')
    return 'failed'
  }
}
