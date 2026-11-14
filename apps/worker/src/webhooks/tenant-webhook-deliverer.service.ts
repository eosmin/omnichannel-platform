import { createHmac } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  WEBHOOK_USER_AGENT,
  WebhookDeliveryErrors,
  WebhookHeaders,
  WebhookLimits,
  WebhookStatus
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { CORRELATION_ID_HEADER } from '@platform/core/logger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { TriggerWebhookJob } from '@platform/core/queues'
import { UnsafeUrlError } from '@platform/core/url-safety'

import { pinnedHttpsPost, WebhookPostFailed } from './pinned-https-post'

export const WebhookOutcome = {
  DELIVERED: 'delivered',
  SKIPPED: 'skipped', // The webhook is gone, or is not active any more: nothing to send, nothing to log
  FAILED_FOR_GOOD: 'failed_for_good' // This delivery will not be sent again; the next event is a new delivery
} as const
export type WebhookOutcome = (typeof WebhookOutcome)[keyof typeof WebhookOutcome]

// The status column is text: compared with the value of the enum as text
const ACTIVE: string = WebhookStatus.ACTIVE

// Prisma's "record not found" and "foreign key failed": the webhook was deleted while its delivery was running
const GONE_CODES: ReadonlySet<string> = new Set(['P2025', 'P2003'])

// The delivery of one event to one webhook of a store (TDD_07 §2). The job holds the webhook by id and the store it was queued
// for: the webhook is read under that store, so a job can never reach another store's endpoint or secret. The address is checked
// again now, because a name can lead somewhere else than it did when it was saved, and the post connects to the address that
// check read. Every attempt leaves a row in the log. After WebhookLimits.MAX_CONSECUTIVE_FAILURES failures in a row the webhook is
// turned off and the people who manage webhooks are told, once.
@Injectable()
export class TenantWebhookDeliverer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly events: DomainEvents,
    @InjectMetric(MetricNames.WEBHOOK_DELIVERIES) private readonly deliveries: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(TenantWebhookDeliverer.name)
  }

  // Throws the failure that BullMQ should retry; returns for everything that is final
  // `post` and `now` are replaceable so that a test needs neither a network nor a clock
  async deliver(
    job: TriggerWebhookJob,
    attempt: number,
    { post = pinnedHttpsPost, now = Date.now, maxAttempts = 1 }: DeliveryDeps = {}
  ): Promise<WebhookOutcome> {
    const { webhookId, storeId, event, payload, deliveryId } = job
    const webhook = await this.prisma.client.webhook.findFirst({
      where: { id: webhookId, storeId },
      select: { url: true, secret: true, status: true, events: true }
    })
    if (webhook === null || webhook.status !== ACTIVE) return WebhookOutcome.SKIPPED
    // The store may have stopped following the event since it was queued (or between two tries of the delivery)
    if (!webhook.events.includes(event)) return WebhookOutcome.SKIPPED

    const startedAt = now()
    let statusCode: number
    try {
      // Inside the try: a secret that cannot be opened (the key changed, a damaged column) is a failure that is written down and
      // counted, not a job that dies in BullMQ with nothing in the log of the webhook
      const secret = this.openSecret(webhook.secret)
      const body = JSON.stringify({ event, data: payload, timestamp: now(), deliveryId })
      const signature = createHmac('sha256', secret).update(body).digest('hex')
      statusCode = await post(webhook.url, {
        body,
        timeoutMs: WebhookLimits.DELIVERY_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'user-agent': WEBHOOK_USER_AGENT,
          [WebhookHeaders.SIGNATURE]: `sha256=${signature}`,
          [WebhookHeaders.EVENT]: event,
          [WebhookHeaders.DELIVERY]: deliveryId,
          ...(job.correlationId === undefined ? {} : { [CORRELATION_ID_HEADER]: job.correlationId })
        }
      })
    } catch (error) {
      const failure = failureOf(error)
      // A delivery is one failure of the webhook when it is over: when no try is left, or when no try would help. The tries
      // of one event while an endpoint restarts are not twenty failures in a row.
      const final = !failure.retryable || attempt >= maxAttempts
      const disabled = await this.recordFailure(job, failure, now() - startedAt, attempt, final)
      // Turned off: the rest of the retries of this delivery would go nowhere
      if (disabled || !failure.retryable) return WebhookOutcome.FAILED_FOR_GOOD
      throw error
    }
    // Outside the try: the endpoint took the delivery, and a failure to write that down must not send it again nor count as one
    // that failed. A gap in the log is said in the logs of the worker; the delivery stands.
    try {
      await this.recordSuccess(webhookId, event, statusCode, now() - startedAt, attempt)
    } catch (error) {
      this.logger.error(
        { webhookId, err: String(error) },
        'a delivery was made and could not be logged'
      )
    }
    return WebhookOutcome.DELIVERED
  }

  private openSecret(sealed: Uint8Array): string {
    let secret: unknown
    try {
      secret = this.cipher.open(sealed)['secret']
    } catch {
      // A wrong key, damaged bytes or JSON that is not what was sealed: all of them are a secret nobody can read
      throw new UnreadableSecret()
    }
    if (typeof secret !== 'string' || secret === '') throw new UnreadableSecret()
    return secret
  }

  private async recordSuccess(
    webhookId: string,
    event: string,
    statusCode: number,
    durationMs: number,
    attempt: number
  ): Promise<void> {
    this.deliveries.inc({ success: 'true' })
    await this.guarded(webhookId, async () => {
      await this.prisma.client.webhookDelivery.create({
        data: { webhookId, event, statusCode, durationMs, success: true, attempt }
      })
      // The count is written only when there is something to clear: a healthy webhook costs one insert
      await this.prisma.client.webhook.updateMany({
        where: { id: webhookId, consecutiveFailures: { gt: 0 } },
        data: { consecutiveFailures: 0 }
      })
    })
  }

  // True when this failure was the one that turned the webhook off
  private async recordFailure(
    job: TriggerWebhookJob,
    failure: Failure,
    durationMs: number,
    attempt: number,
    final: boolean
  ): Promise<boolean> {
    const { webhookId, storeId, event } = job
    this.deliveries.inc({ success: 'false' })
    let disabled = false
    await this.guarded(webhookId, async () => {
      disabled = await this.prisma.transaction(async tx => {
        await tx.webhookDelivery.create({
          data: {
            webhookId,
            event,
            statusCode: failure.status,
            durationMs,
            success: false,
            error: failure.code.slice(0, WebhookLimits.DELIVERY_ERROR_MAX_LENGTH),
            attempt
          }
        })
        // Every try is a row of the log; only the end of a delivery counts toward turning the webhook off
        const updated = await tx.webhook.update({
          where: { id: webhookId },
          data: {
            lastFailureAt: new Date(),
            ...(final ? { consecutiveFailures: { increment: 1 } } : {})
          },
          select: { consecutiveFailures: true }
        })
        if (!final) return false
        if (updated.consecutiveFailures < WebhookLimits.MAX_CONSECUTIVE_FAILURES) return false
        // Only the one that changes it from active tells anybody: two deliveries that fail together say it once
        const turnedOff = await tx.webhook.updateMany({
          where: { id: webhookId, storeId, status: WebhookStatus.ACTIVE },
          data: { status: WebhookStatus.DISABLED }
        })
        if (turnedOff.count === 0) return false
        this.events.publish(tx, Events.WEBHOOK_AUTO_DISABLED, {
          storeId,
          webhookId,
          consecutiveFailures: updated.consecutiveFailures
        })
        return true
      })
    })
    if (disabled)
      this.logger.warn({ webhookId, storeId }, 'a webhook was turned off after repeated failures')
    return disabled
  }

  // A webhook deleted while its delivery ran has no log to write to: that is the end of it, not an error to retry
  private async guarded(webhookId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string' && GONE_CODES.has(code)) {
        this.logger.info({ webhookId }, 'a webhook was deleted while its delivery ran')
        return
      }
      throw error
    }
  }
}

export interface DeliveryDeps {
  post?: typeof pinnedHttpsPost
  // The tries BullMQ gives the job: the last failure is the one that counts
  maxAttempts?: number
  now?: () => number
}

// The sealed secret cannot be opened: no delivery of this webhook can be signed until somebody makes a new one
class UnreadableSecret extends Error {
  constructor() {
    super('the webhook secret is unreadable')
    this.name = 'UnreadableSecret'
  }
}

interface Failure {
  status: number | null
  code: string
  retryable: boolean
}

function failureOf(error: unknown): Failure {
  if (error instanceof WebhookPostFailed) {
    return { status: error.status, code: error.reason, retryable: error.retryable }
  }
  if (
    error instanceof UnreadableSecret ||
    (error instanceof Error && error.name === 'DecryptionError')
  ) {
    return { status: null, code: WebhookDeliveryErrors.SECRET_UNREADABLE, retryable: false }
  }
  // The address no longer leads to the public internet: sending it again will not change that
  if (error instanceof UnsafeUrlError) {
    return { status: null, code: WebhookDeliveryErrors.ADDRESS_NOT_ALLOWED, retryable: false }
  }
  return { status: null, code: WebhookDeliveryErrors.UNEXPECTED, retryable: true }
}
