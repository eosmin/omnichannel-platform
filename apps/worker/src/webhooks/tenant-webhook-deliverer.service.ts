// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one call; the POST to the endpoint is made outside of it
import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { WebhookStatus } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MetricNames, WebhookMetricTarget } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { TriggerWebhookJob } from '@platform/core/queues'

import { pinnedHttpsPost } from './pinned-https-post'
import { type DeliveryBinding, WebhookDeliveryRecorder } from './webhook-delivery-recorder'
import {
  type DeliveryDeps,
  failureOf,
  openSecret,
  sendSigned,
  WebhookOutcome
} from './webhook-sending'

export { WebhookOutcome, type DeliveryDeps } from './webhook-sending'

// The status column is text: compared with the value of the enum as text
const ACTIVE: string = WebhookStatus.ACTIVE

// The delivery of one event to one webhook of a store (TDD_07 §2). The job holds the webhook by id and the store it was queued
// for: the webhook is read under that store, so a job can never reach another store's endpoint or secret. The address is checked
// again now, because a name can lead somewhere else than it did when it was saved, and the post connects to the address that
// check read. Every attempt leaves a row in the log. After WebhookLimits.MAX_CONSECUTIVE_FAILURES failures in a row the webhook is
// turned off and the people who manage webhooks are told, once.
@Injectable()
export class TenantWebhookDeliverer {
  private readonly recorder: WebhookDeliveryRecorder

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly events: DomainEvents,
    @InjectMetric(MetricNames.WEBHOOK_DELIVERIES) deliveries: Counter<string>,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    @InjectMetric(MetricNames.WEBHOOK_GONE_BEHIND_POLICY)
    goneBehindPolicy: Counter<string>
  ) {
    this.logger.setContext(TenantWebhookDeliverer.name)
    this.recorder = new WebhookDeliveryRecorder(
      prisma,
      jobContext,
      deliveries,
      goneBehindPolicy,
      logger
    )
  }

  // Throws the failure that BullMQ should retry; returns for everything that is final
  // `post` and `now` are replaceable so that a test needs neither a network nor a clock
  async deliver(
    job: TriggerWebhookJob,
    attempt: number,
    { post = pinnedHttpsPost, now = Date.now, maxAttempts = 1 }: DeliveryDeps = {}
  ): Promise<WebhookOutcome> {
    const { webhookId, storeId, event, payload, deliveryId } = job
    const webhook = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.webhook.findFirst({
        where: { id: webhookId, storeId },
        select: { url: true, secret: true, status: true, events: true }
      })
    )
    if (webhook === null || webhook.status !== ACTIVE) return WebhookOutcome.SKIPPED
    // The store may have stopped following the event since it was queued (or between two tries of the delivery)
    if (!webhook.events.includes(event)) return WebhookOutcome.SKIPPED

    const startedAt = now()
    let statusCode: number
    try {
      // Inside the try: a secret that cannot be opened (the key changed, a damaged column) is a failure that is written down and
      // counted, not a job that dies in BullMQ with nothing in the log of the webhook
      const secret = openSecret(this.cipher, webhook.secret)
      statusCode = await sendSigned({
        url: webhook.url,
        secret,
        event,
        deliveryId,
        payload,
        correlationId: job.correlationId,
        post,
        now
      })
    } catch (error) {
      const failure = failureOf(error)
      // A delivery is one failure of the webhook when it is over: when no try is left, or when no try would help. The tries
      // of one event while an endpoint restarts are not twenty failures in a row.
      const final = !failure.retryable || attempt >= maxAttempts
      const disabled = await this.recorder.failure(this.bindingOf(storeId, webhookId), storeId, {
        failure,
        event,
        durationMs: now() - startedAt,
        attempt,
        over: final
      })
      // Turned off: the rest of the retries of this delivery would go nowhere
      if (disabled || !failure.retryable) return WebhookOutcome.FAILED_FOR_GOOD
      throw error
    }
    // Outside the try: the endpoint took the delivery, and a failure to write that down must not send it again nor count as one
    // that failed. A gap in the log is said in the logs of the worker; the delivery stands.
    try {
      await this.recorder.success(this.bindingOf(storeId, webhookId), storeId, {
        event,
        statusCode,
        durationMs: now() - startedAt,
        attempt
      })
    } catch (error) {
      this.logger.error(
        { webhookId, err: String(error) },
        'a delivery was made and could not be logged'
      )
    }
    return WebhookOutcome.DELIVERED
  }

  // A webhook deleted while its delivery ran has no log to write to: the recorder says whether that is the end of it
  private async guarded(
    storeId: string,
    webhookId: string,
    work: () => Promise<void>
  ): Promise<void> {
    await this.recorder.guarded(this.bindingOf(storeId, webhookId), storeId, work)
  }

  // The webhook of a store, for the recorder: its log, its count of failures in a row and how it is turned off
  private bindingOf(storeId: string, webhookId: string): DeliveryBinding {
    return {
      target: WebhookMetricTarget.TENANT,
      noun: 'a webhook',
      disabledMessage: 'a webhook was turned off after repeated failures',
      logFields: { webhookId },
      exists: async () => {
        const row = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.webhook.findFirst({
            where: { id: webhookId, storeId },
            select: { id: true }
          })
        )
        return row !== null
      },
      writeSuccess: async row => {
        await this.prisma.client.webhookDelivery.create({ data: { webhookId, ...row } })
        // The count is written only when there is something to clear: a healthy webhook costs one insert
        await this.prisma.client.webhook.updateMany({
          where: { id: webhookId, storeId, consecutiveFailures: { gt: 0 } },
          data: { consecutiveFailures: 0 }
        })
      },
      writeFailureRow: async (tx, row) => {
        await tx.webhookDelivery.create({ data: { webhookId, ...row } })
      },
      markFailure: async (tx, counts) => {
        const updated = await tx.webhook.update({
          where: { id: webhookId, storeId },
          data: {
            lastFailureAt: new Date(),
            ...(counts ? { consecutiveFailures: { increment: 1 } } : {})
          },
          select: { consecutiveFailures: true }
        })
        return updated.consecutiveFailures
      },
      turnOff: async (tx, consecutiveFailures) => {
        const turnedOff = await tx.webhook.updateMany({
          where: { id: webhookId, storeId, status: WebhookStatus.ACTIVE },
          data: { status: WebhookStatus.DISABLED }
        })
        if (turnedOff.count === 0) return false
        this.events.publish(tx, Events.WEBHOOK_AUTO_DISABLED, {
          storeId,
          webhookId,
          consecutiveFailures
        })
        return true
      }
    }
  }
}
