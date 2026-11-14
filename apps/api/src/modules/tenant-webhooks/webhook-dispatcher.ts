import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { isWebhookEvent, WebhookStatus } from '@platform/core/domain'
import { JobNames, QueueNames, type TriggerWebhookJob } from '@platform/core/queues'

// Turns what happens in a store into the deliveries of its webhooks (TDD_07 §2): every event of the catalog that the bus
// carries is looked up against the active webhooks of the store named in its payload, and one job is queued for each that
// follows it. Nothing is sent from here: the worker signs and posts, so a slow endpoint never holds a request of the api.
// The store is the one of the event, raised by the code that changed the data, and never a value of a request.
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly listener = (event: string | string[], payload: unknown): void => {
    // Fire and forget: an event is already committed, and a failure here is a delivery lost, not a request failed
    void this.dispatch(Array.isArray(event) ? event.join('.') : event, payload)
  }

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.WEBHOOKS) private readonly queue: Queue<TriggerWebhookJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(WebhookDispatcher.name)
  }

  onModuleInit(): void {
    this.emitter.onAny(this.listener)
  }

  onModuleDestroy(): void {
    this.emitter.offAny(this.listener)
  }

  async dispatch(event: string, payload: unknown): Promise<number> {
    if (!isWebhookEvent(event)) return 0
    const body = withoutText(asRecord(payload))
    const storeId = body?.storeId
    if (body === null || typeof storeId !== 'string') return 0
    try {
      const webhooks = await this.prisma.client.webhook.findMany({
        where: { storeId, status: WebhookStatus.ACTIVE, events: { has: event } },
        select: { id: true }
      })
      if (webhooks.length === 0) return 0
      await this.queue.addBulk(
        webhooks.map(webhook => {
          const deliveryId = randomUUID()
          return {
            name: JobNames.TRIGGER_WEBHOOK,
            data: { webhookId: webhook.id, storeId, deliveryId, event, payload: body },
            // The id of the job is the id of the delivery, which the receiver sees in a header
            opts: { jobId: deliveryId }
          }
        })
      )
      return webhooks.length
    } catch (error) {
      this.logger.error(
        { event, storeId, err: String(error) },
        'the webhooks of an event could not be queued'
      )
      return 0
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// The text of a message never leaves for an address of the store's choosing, whatever an emitter put in its payload
const TEXT_FIELDS: ReadonlySet<string> = new Set(['contentPreview', 'firstMessageContent'])

function withoutText(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (record === null) return null
  return Object.fromEntries(Object.entries(record).filter(([key]) => !TEXT_FIELDS.has(key)))
}
