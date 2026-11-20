// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one call; the POST to the endpoint is made outside of it
import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { WebhookLimits, WebhookStatus } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MetricNames, WebhookMetricTarget } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { TriggerWebhookJob } from '@platform/core/queues'

import { GoneVerdict, judgeGone } from './gone-verdict'
import { pinnedHttpsPost } from './pinned-https-post'
import {
  type DeliveryDeps,
  failureOf,
  type Failure,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly events: DomainEvents,
    @InjectMetric(MetricNames.WEBHOOK_DELIVERIES) private readonly deliveries: Counter<string>,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    @InjectMetric(MetricNames.WEBHOOK_GONE_BEHIND_POLICY)
    private readonly goneBehindPolicy: Counter<string>
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
      const disabled = await this.recordFailure(job, failure, now() - startedAt, attempt, final)
      // Turned off: the rest of the retries of this delivery would go nowhere
      if (disabled || !failure.retryable) return WebhookOutcome.FAILED_FOR_GOOD
      throw error
    }
    // Outside the try: the endpoint took the delivery, and a failure to write that down must not send it again nor count as one
    // that failed. A gap in the log is said in the logs of the worker; the delivery stands.
    try {
      await this.recordSuccess(storeId, webhookId, event, statusCode, now() - startedAt, attempt)
    } catch (error) {
      this.logger.error(
        { webhookId, err: String(error) },
        'a delivery was made and could not be logged'
      )
    }
    return WebhookOutcome.DELIVERED
  }

  private async recordSuccess(
    storeId: string,
    webhookId: string,
    event: string,
    statusCode: number,
    durationMs: number,
    attempt: number
  ): Promise<void> {
    this.deliveries.inc({ target: WebhookMetricTarget.TENANT, success: 'true' })
    // The context is opened inside `guarded`: a webhook deleted meanwhile breaks the transaction, and that is read outside of it
    await this.guarded(storeId, webhookId, () =>
      this.jobContext.forStore(storeId, async () => {
        await this.prisma.client.webhookDelivery.create({
          data: { webhookId, event, statusCode, durationMs, success: true, attempt }
        })
        // The count is written only when there is something to clear: a healthy webhook costs one insert
        await this.prisma.client.webhook.updateMany({
          where: { id: webhookId, storeId, consecutiveFailures: { gt: 0 } },
          data: { consecutiveFailures: 0 }
        })
      })
    )
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
    this.deliveries.inc({ target: WebhookMetricTarget.TENANT, success: 'false' })
    let disabled = false
    await this.guarded(storeId, webhookId, () =>
      this.jobContext.forStore(storeId, async () => {
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
            where: { id: webhookId, storeId },
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
    )
    if (disabled)
      this.logger.warn({ webhookId, storeId }, 'a webhook was turned off after repeated failures')
    return disabled
  }

  // A webhook deleted while its delivery ran has no log to write to: that is the end of it, not an error to retry. With the policy on,
  // the insert is refused (42501) before the foreign key can fail, so the webhook is looked up again, in a new unit of work and outside
  // the one that broke: only its absence is a deletion, and a refusal with the webhook still there is thrown as it came.
  private async guarded(
    storeId: string,
    webhookId: string,
    work: () => Promise<void>
  ): Promise<void> {
    try {
      await work()
    } catch (error) {
      const verdict = await judgeGone(error, async () => {
        const row = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.webhook.findFirst({
            where: { id: webhookId, storeId },
            select: { id: true }
          })
        )
        return row !== null
      })
      if (verdict === GoneVerdict.NOT_GONE) throw error
      if (verdict === GoneVerdict.DELETED_BEHIND_POLICY) {
        this.goneBehindPolicy.inc({ target: WebhookMetricTarget.TENANT })
        this.logger.warn(
          { webhookId, storeId, code: 'row_level_security' },
          'a webhook was deleted while its delivery ran: the log row was refused by the policy'
        )
        return
      }
      this.logger.info({ webhookId }, 'a webhook was deleted while its delivery ran')
    }
  }
}
