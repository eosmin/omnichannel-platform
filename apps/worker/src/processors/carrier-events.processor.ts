import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { isWebhookEvent, ShipmentEventSource } from '@platform/core/domain'
import { type EventName, Events } from '@platform/core/events'
import {
  exactly,
  jobCorrelationIdSchema,
  JobNames,
  QueueNames,
  type TriggerPluginWebhookJob,
  type TriggerWebhookJob
} from '@platform/core/queues'
import { carrierEventSchema, type ProcessCarrierEventJob } from '@platform/plugins/runtime'

import {
  CarrierEventApplier,
  CarrierEventHandled,
  type CarrierEventHandledType
} from '../carriers/carrier-event-applier.service'
import { PluginWebhookDeliverer } from '../webhooks/plugin-webhook-deliverer.service'
import { TenantWebhookDeliverer } from '../webhooks/tenant-webhook-deliverer.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

// The keys of the job type, checked when it is compiled: zod drops what it is not told about. The store comes from the
// connection the api authenticated, and the job crossed Redis, so it is checked again before anything reads it.
const carrierEventJobSchema = exactly<ProcessCarrierEventJob>()(
  z.object({
    storeId: z.uuid(),
    connectionId: z.uuid(),
    event: carrierEventSchema,
    receivedAt: z.iso.datetime({ offset: true }),
    correlationId: jobCorrelationIdSchema
  })
)

// The same, for the delivery of a webhook of a store (TDD_07 §2): the api queued one job per active webhook that follows the event.
// The store comes from the job the api made, and the job crossed Redis, so it is checked again before anything reads it.
const webhookJobSchema = exactly<TriggerWebhookJob>()(
  z.object({
    webhookId: z.uuid(),
    storeId: z.uuid(),
    deliveryId: z.uuid(),
    event: z.custom<EventName>(value => typeof value === 'string' && isWebhookEvent(value)),
    payload: z.record(z.string(), z.unknown()),
    // It travels as a header: only what a header may carry
    correlationId: z
      .string()
      .regex(/^[\w.:-]{1,128}$/)
      .optional()
  })
)

// The delivery of an event to the webhook of a plugin installation (TDD_10 §6.5): the api queued one job per installation that
// follows the event, with the payload already redacted to its scopes, and one more when the installation was revoked. The job
// crossed Redis, so what the deliverer reads is checked again.
const pluginWebhookJobSchema = exactly<TriggerPluginWebhookJob>()(
  z.object({
    pluginInstallationId: z.uuid(),
    storeId: z.uuid(),
    deliveryId: z.uuid(),
    event: z.custom<EventName>(
      value =>
        typeof value === 'string' && (isWebhookEvent(value) || value === Events.PLUGIN_REVOKED)
    ),
    payload: z.record(z.string(), z.unknown()),
    final: z.boolean().optional(),
    correlationId: z
      .string()
      .regex(/^[\w.:-]{1,128}$/)
      .optional()
  })
)

type WebhooksQueueJob = ProcessCarrierEventJob | TriggerWebhookJob | TriggerPluginWebhookJob

// The worker half of TDD_17 §4.9: the api verified the signature of the carrier and queued one job per event; this reads
// them. (The queue also carries the deliveries of the webhooks of the stores, which the processor hands to its deliverer.) Each one is resolved for its connection, finds its shipment and moves it through the status engine (dedupe, order of
// arrival, the transition table), or is kept in the history when nobody has said what its code means (§4.17).
@Processor(QueueNames.WEBHOOKS, { concurrency: 10 })
export class CarrierEventsProcessor extends BaseProcessor<WebhooksQueueJob> {
  constructor(
    support: ProcessorSupport,
    private readonly applier: CarrierEventApplier,
    private readonly webhooks: TenantWebhookDeliverer,
    private readonly pluginWebhooks: PluginWebhookDeliverer
  ) {
    super(QueueNames.WEBHOOKS, support)
  }

  protected async handle(job: Job<WebhooksQueueJob>): Promise<void> {
    // BullMQ gives a job to any worker of the queue, not by name, so the processor dispatches by the name of the job
    switch (job.name) {
      case JobNames.PROCESS_CARRIER_EVENT:
        await this.handleCarrierEvent(job)
        return
      case JobNames.TRIGGER_WEBHOOK:
        await this.handleWebhook(job)
        return
      case JobNames.TRIGGER_PLUGIN_WEBHOOK:
        await this.handlePluginWebhook(job)
        return
      default:
        throw new UnrecoverableError('this queue has no processor for that job yet')
    }
  }

  private async handleWebhook(job: Job<WebhooksQueueJob>): Promise<void> {
    const parsed = webhookJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the webhook job does not fit its schema')
    // A failure that may pass throws and BullMQ asks again; every attempt is a row of the delivery log
    await this.skipIfGone(job, () =>
      this.webhooks.deliver(parsed.data, job.attemptsMade + 1, {
        maxAttempts: job.opts.attempts ?? 1
      })
    )
  }

  private async handlePluginWebhook(job: Job<WebhooksQueueJob>): Promise<void> {
    const parsed = pluginWebhookJobSchema.safeParse(job.data)
    if (!parsed.success) {
      throw new UnrecoverableError('the plugin webhook job does not fit its schema')
    }
    await this.skipIfGone(job, () =>
      this.pluginWebhooks.deliver(parsed.data, job.attemptsMade + 1, {
        maxAttempts: job.opts.attempts ?? 1
      })
    )
  }

  private async handleCarrierEvent(job: Job<WebhooksQueueJob>): Promise<void> {
    const parsed = carrierEventJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success)
      throw new UnrecoverableError('the carrier event job does not fit its schema')
    const applied: { outcome?: CarrierEventHandledType } = {}
    await this.skipIfGone(job, async () => {
      applied.outcome = await this.applier.apply(parsed.data, ShipmentEventSource.WEBHOOK)
    })
    // A store that was deleted meanwhile: the job is done, and nothing was applied
    const { outcome } = applied
    if (outcome === undefined) return
    // Not an error of the job but a thing that may change in a moment: the carrier's own books lag behind its webhook, and a
    // webhook can outrun the guide being stored. BullMQ asks again; what never resolves ends in the dead letter queue, where a
    // person sees it, and not as a success that hides a lost event
    if (outcome === CarrierEventHandled.UNCONFIRMED || outcome === CarrierEventHandled.NOT_FOUND) {
      throw new Error(`the carrier event is not settled yet (${outcome})`)
    }
  }
}
