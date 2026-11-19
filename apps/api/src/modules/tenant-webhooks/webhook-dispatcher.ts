import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { EventContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import {
  isWebhookEvent,
  PluginInstallationStatus,
  PluginStatus,
  type WebhookEvent,
  WebhookStatus
} from '@platform/core/domain'
import {
  JobNames,
  QueueNames,
  type TriggerPluginWebhookJob,
  type TriggerWebhookJob
} from '@platform/core/queues'
import { manifestWebhookOf } from '@platform/plugins/runtime'
import { PluginEventScopes, redactForScopes } from '@platform/plugins/sdk'

// Turns what happens in a store into the deliveries of its webhooks (TDD_07 §2): every event of the catalog that the bus
// carries is looked up against the active webhooks of the store named in its payload, and one job is queued for each that
// follows it. The plugins installed in that store are looked up in the same pass (TDD_10 §6.5): each one that follows the event
// and was granted its scope gets one job with the payload redacted to what its scopes open. Nothing is sent from here: the worker
// signs and posts, so a slow endpoint never holds a request of the api. The store is the one of the event, raised by the code
// that changed the data, and never a value of a request: an installation of another store is not even read.
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly listener = (event: string | string[], payload: unknown): void => {
    // Fire and forget: an event is already committed, and a failure here is a delivery lost, not a request failed
    void this.dispatch(Array.isArray(event) ? event.join('.') : event, payload)
  }

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly events: EventContext,
    @InjectQueue(QueueNames.WEBHOOKS)
    private readonly queue: Queue<TriggerWebhookJob | TriggerPluginWebhookJob>,
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
    if (body === null || typeof storeId !== 'string' || storeId === '') {
      // Every event of the catalog names its store: one that does not is a bug of its emitter, and its webhooks would be lost in
      // silence. The id is never taken from anywhere else.
      this.logger.error(
        { event },
        'an event of the webhook catalog carries no store: not dispatched'
      )
      return 0
    }
    // Each side fails on its own: a store whose webhooks could not be read does not cost its plugins their delivery
    const [tenants, plugins] = await Promise.all([
      this.dispatchToTenants(event, storeId, body),
      this.dispatchToPlugins(event, storeId, body)
    ])
    return tenants + plugins
  }

  private async dispatchToTenants(
    event: WebhookEvent,
    storeId: string,
    body: Record<string, unknown>
  ): Promise<number> {
    try {
      // The read is the only work inside the context of the store; the queue is asked after it has closed
      const webhooks = await this.events.inStore(storeId, () =>
        this.prisma.client.webhook.findMany({
          where: { storeId, status: WebhookStatus.ACTIVE, events: { has: event } },
          select: { id: true }
        })
      )
      if (webhooks.length === 0) return 0
      await this.queue.addBulk(
        webhooks.map(webhook => {
          const deliveryId = randomUUID()
          const data: TriggerWebhookJob = {
            webhookId: webhook.id,
            storeId,
            deliveryId,
            event,
            payload: body
          }
          return {
            name: JobNames.TRIGGER_WEBHOOK,
            data,
            // The id of the job is the id of the delivery, which the receiver sees in a header
            opts: { jobId: deliveryId }
          }
        })
      )
      return webhooks.length
    } catch (error) {
      // A store deleted after the event has nothing left to deliver
      if (error instanceof JobContextGoneError) return 0
      this.logger.error(
        { event, storeId, err: String(error) },
        'the webhooks of an event could not be queued'
      )
      return 0
    }
  }

  // The installations of the store that follow the event: active, with the endpoint that passed the challenge and the secret
  // that signs, not turned off, of a plugin that is still approved (a suspended plugin gets nothing). What each one follows is
  // read from its plugin's manifest and what it may be told from the scopes it was granted, never from the manifest.
  private async dispatchToPlugins(
    event: WebhookEvent,
    storeId: string,
    body: Record<string, unknown>
  ): Promise<number> {
    // An event no plugin is sent (the returns, until they have a scope) costs no query
    const needed = PluginEventScopes[event]
    if (needed === undefined) return 0
    try {
      const installations = await this.events.inStore(storeId, () =>
        this.prisma.client.pluginInstallation.findMany({
          where: {
            storeId,
            scopes: { has: needed },
            status: PluginInstallationStatus.ACTIVE,
            webhookEndpoint: { not: null },
            webhookSecret: { not: null },
            webhookDisabledAt: null,
            plugin: { status: PluginStatus.APPROVED }
          },
          select: { id: true, scopes: true, plugin: { select: { manifest: true } } }
        })
      )
      const jobs = installations.flatMap(installation => {
        if (manifestWebhookOf(installation.plugin.manifest)?.events.includes(event) !== true) {
          return []
        }
        const data = redactForScopes(event, body, installation.scopes)
        if (data === null) return []
        const deliveryId = randomUUID()
        const job: TriggerPluginWebhookJob = {
          pluginInstallationId: installation.id,
          storeId,
          deliveryId,
          event,
          payload: data
        }
        return [{ name: JobNames.TRIGGER_PLUGIN_WEBHOOK, data: job, opts: { jobId: deliveryId } }]
      })
      if (jobs.length === 0) return 0
      await this.queue.addBulk(jobs)
      return jobs.length
    } catch (error) {
      // A store deleted after the event has nothing left to deliver
      if (error instanceof JobContextGoneError) return 0
      this.logger.error(
        { event, storeId, err: String(error) },
        'the plugin webhooks of an event could not be queued'
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
