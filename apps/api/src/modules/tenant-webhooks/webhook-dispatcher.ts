import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import {
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
  Inject
} from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { Counter } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  EventContext,
  inSavepoint,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import {
  isWebhookEvent,
  WebhookDispatchLossReasons,
  type WebhookDispatchLossReason,
  WebhookDispatchReadRetryPausesMs,
  PluginInstallationStatus,
  PluginStatus,
  type WebhookEvent,
  WebhookStatus
} from '@platform/core/domain'
import { isLockTimeoutError, isTransactionWaitError } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'
import { getMetricToken } from '@platform/core/metrics-module'
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
    private readonly logger: PinoLogger,
    // The deliveries that were never queued, by reason: the trace to alert on (a log line is not read by anyone at 3 am)
    @Optional()
    @Inject(getMetricToken(MetricNames.WEBHOOK_DISPATCH_LOST))
    private readonly lost?: Counter<string>
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
      this.countLost(WebhookDispatchLossReasons.NO_STORE)
      return 0
    }
    // ONE short context per event (it is heard for every store and event) holds both reads. Each read is in its own savepoint, so a
    // read that fails does not abort the transaction of the other: a store whose webhooks could not be read does not cost its plugins
    // their delivery. The queue is asked after the context has closed.
    const read = await this.readWithRetries(event, storeId)
    if (read === null) return 0
    const tenants = await this.queueTenants(event, storeId, body, read.webhooks)
    const plugins = await this.queuePlugins(event, storeId, body, read.installations)
    return tenants + plugins
  }

  // A lock timeout or a busy pool is the database asking for a pause, not an answer: the read is made again, a bounded number of times,
  // each in a context of its own. Anything else (and the last try) is a delivery lost: logged and counted. A store that is gone, or
  // that has nobody to tell, is no loss.
  private async readWithRetries(event: WebhookEvent, storeId: string): Promise<Reads | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.events.inStore(storeId, () => this.read(event, storeId))
      } catch (error) {
        // A store deleted after the event has nothing left to deliver
        if (error instanceof JobContextGoneError) return null
        const pause = WebhookDispatchReadRetryPausesMs[attempt]
        if (isTransient(error) && pause !== undefined) {
          await new Promise<void>(resolve => setTimeout(resolve, pause))
          continue
        }
        this.logger.error(
          { event, storeId, attempts: attempt + 1, err: String(error) },
          'the webhooks of an event could not be read'
        )
        this.countLost(WebhookDispatchLossReasons.READ_FAILED)
        return null
      }
    }
  }

  private countLost(reason: WebhookDispatchLossReason, amount = 1): void {
    this.lost?.inc({ reason }, amount)
  }

  private async read(event: WebhookEvent, storeId: string): Promise<Reads> {
    const webhooks = await this.attempt(
      event,
      storeId,
      'the webhooks of an event could not be read',
      () =>
        this.prisma.client.webhook.findMany({
          where: { storeId, status: WebhookStatus.ACTIVE, events: { has: event } },
          select: { id: true }
        })
    )
    // An event no plugin is sent (the returns, until they have a scope) costs no query
    const needed = PluginEventScopes[event]
    // The installations of the store that follow the event: active, with the endpoint that passed the challenge and the secret
    // that signs, not turned off, of a plugin that is still approved (a suspended plugin gets nothing)
    const installations =
      needed === undefined
        ? []
        : await this.attempt(
            event,
            storeId,
            'the plugin installations of an event could not be read',
            () =>
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
    return { webhooks, installations }
  }

  // One read in its own savepoint: a failure is logged and answers nothing, and the transaction stays usable for the next read
  private async attempt<T>(
    event: WebhookEvent,
    storeId: string,
    message: string,
    read: () => Promise<T[]>
  ): Promise<T[]> {
    try {
      return await inSavepoint(read)
    } catch (error) {
      // Not answered here: the whole read is made again after a pause (readWithRetries)
      if (error instanceof JobContextGoneError || isTransient(error)) throw error
      this.logger.error({ event, storeId, err: String(error) }, message)
      this.countLost(WebhookDispatchLossReasons.READ_FAILED)
      return []
    }
  }

  private async queueTenants(
    event: WebhookEvent,
    storeId: string,
    body: Record<string, unknown>,
    webhooks: Reads['webhooks']
  ): Promise<number> {
    if (webhooks.length === 0) return 0
    try {
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
      this.logger.error(
        { event, storeId, err: String(error) },
        'the webhooks of an event could not be queued'
      )
      this.countLost(WebhookDispatchLossReasons.QUEUE_FAILED, webhooks.length)
      return 0
    }
  }

  // What each installation follows is read from its plugin's manifest and what it may be told from the scopes it was granted,
  // never from the manifest.
  private async queuePlugins(
    event: WebhookEvent,
    storeId: string,
    body: Record<string, unknown>,
    installations: Reads['installations']
  ): Promise<number> {
    let attempted = 0
    try {
      let hidden = 0
      const jobs = installations.flatMap(installation => {
        // Row security may hide the plugin of an installation (the join reads `plugins` under the policy of the store): the row
        // then comes with no plugin. That installation is skipped, never the whole dispatch.
        const plugin: { manifest: unknown } | null = installation.plugin
        if (plugin === null) {
          hidden += 1
          return []
        }
        if (manifestWebhookOf(plugin.manifest)?.events.includes(event) !== true) {
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
      if (hidden > 0) {
        this.logger.error(
          { event, storeId, hidden },
          'installations whose plugin is not visible were skipped'
        )
      }
      if (jobs.length === 0) return 0
      attempted = jobs.length
      await this.queue.addBulk(jobs)
      return jobs.length
    } catch (error) {
      this.logger.error(
        { event, storeId, err: String(error) },
        'the plugin webhooks of an event could not be queued'
      )
      if (attempted > 0) this.countLost(WebhookDispatchLossReasons.QUEUE_FAILED, attempted)
      return 0
    }
  }
}

interface Reads {
  webhooks: { id: string }[]
  installations: {
    id: string
    scopes: string[]
    plugin: { manifest: unknown }
  }[]
}

// The database asking for a pause: a lock that timed out, or a pool with no connection free in time
const isTransient = (error: unknown): boolean =>
  isLockTimeoutError(error) || isTransactionWaitError(error)

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
