// rls-context: every database access of this file runs inside a JobContext (forStore) opened around that one call; the POST to the endpoint is made outside of it
import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService, JobContext } from '@platform/core/database'
import {
  PluginInstallationStatus,
  PluginStatus,
  WebhookHeaders,
  WebhookLimits
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MetricNames, WebhookMetricTarget } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { TriggerPluginWebhookJob } from '@platform/core/queues'
import { manifestMaxWebhooksPerDay, manifestWebhookOf } from '@platform/plugins/runtime'
import { PluginEventScopes } from '@platform/plugins/sdk'

import { pinnedHttpsPost } from './pinned-https-post'
import { PluginWebhookDayCap } from './plugin-webhook-day-cap'
import { type DeliveryBinding, WebhookDeliveryRecorder } from './webhook-delivery-recorder'
import {
  type DeliveryDeps,
  failureOf,
  openSecret,
  sendSigned,
  WebhookOutcome
} from './webhook-sending'

// The status columns are text: compared with the values of the enums as text
const ACTIVE: string = PluginInstallationStatus.ACTIVE
const REVOKED: string = PluginInstallationStatus.REVOKED
const APPROVED: string = PluginStatus.APPROVED

// The delivery of one event to the webhook endpoint of one plugin installation (TDD_10 §6.5), the same way a webhook of a store
// is delivered (TenantWebhookDeliverer): signed with the secret of the installation, the address checked again now and the only one
// connected to, every try a row of the same log, and after WebhookLimits.MAX_CONSECUTIVE_FAILURES failed deliveries in a row the
// installation's webhooks are turned off and the people who manage plugins are told, once (`plugin.error`).
//
// The job holds the installation by id and the store it was queued for, and everything is read under that store. The address and
// the secret are the ones kept on the installation (the endpoint that passed the install challenge), never the manifest's. The
// payload was redacted to the granted scopes when it was queued.
//
// The last delivery of a revoked installation (`plugin.revoked`, `final`) is the one exception to "only an active installation":
// it goes while the installation is revoked and still holds its endpoint and secret, and when it is over, whatever the outcome,
// both are removed, so nothing of the subscription outlives the revocation.
@Injectable()
export class PluginWebhookDeliverer {
  private readonly recorder: WebhookDeliveryRecorder

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly events: DomainEvents,
    @InjectMetric(MetricNames.WEBHOOK_DELIVERIES) deliveries: Counter<string>,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    @InjectMetric(MetricNames.WEBHOOK_GONE_BEHIND_POLICY)
    goneBehindPolicy: Counter<string>,
    private readonly dayCap: PluginWebhookDayCap
  ) {
    this.logger.setContext(PluginWebhookDeliverer.name)
    this.recorder = new WebhookDeliveryRecorder(
      prisma,
      jobContext,
      deliveries,
      goneBehindPolicy,
      logger
    )
  }

  // Throws the failure that BullMQ should retry; returns for everything that is final
  async deliver(
    job: TriggerPluginWebhookJob,
    attempt: number,
    { post = pinnedHttpsPost, now = Date.now, maxAttempts = 1 }: DeliveryDeps = {}
  ): Promise<WebhookOutcome> {
    const { pluginInstallationId: installationId, storeId, event, payload, deliveryId } = job
    const final = job.final === true
    const installation = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.pluginInstallation.findFirst({
        where: { id: installationId, storeId },
        select: {
          pluginId: true,
          scopes: true,
          status: true,
          webhookEndpoint: true,
          webhookSecret: true,
          webhookDisabledAt: true,
          plugin: { select: { status: true, manifest: true } }
        }
      })
    )
    if (installation === null) return WebhookOutcome.SKIPPED
    const { webhookEndpoint: endpoint, webhookSecret: sealed } = installation
    const manifest = manifestWebhookOf(installation.plugin.manifest)
    const binding = this.bindingOf(storeId, installationId, installation.pluginId)
    if (final) {
      // Only the delivery that was queued by the revocation, and only while the installation is still revoked: one that was
      // installed again meanwhile has a new secret and a new endpoint, which this one was not made for
      if (installation.status !== REVOKED) return WebhookOutcome.SKIPPED
      // A suspended plugin gets nothing (TDD_15 §7), not even this: the subscription is closed instead
      if (installation.plugin.status !== APPROVED) {
        await this.closeSubscription(installationId, storeId)
        return WebhookOutcome.SKIPPED
      }
    } else if (
      installation.status !== ACTIVE ||
      installation.webhookDisabledAt !== null ||
      // A suspended plugin gets nothing (TDD_15 §7)
      installation.plugin.status !== APPROVED ||
      // The plugin may have stopped following the event since it was queued
      manifest?.events.includes(event) !== true ||
      // The scope that opened the event may be gone since it was queued (the installation was installed again with fewer)
      !pluginHoldsScopeOf(event, installation.scopes)
    ) {
      return WebhookOutcome.SKIPPED
    }
    if (endpoint === null || sealed === null) return WebhookOutcome.SKIPPED
    // The cap of the day the plugin declared (`limits.maxWebhooksPerDay`). The last delivery of a revocation always goes. What is
    // over the cap is dropped, not failed: it is not the endpoint's fault, so it counts toward turning nothing off. The cap is on
    // deliveries STARTED: a first try that fails is one of them. The place is taken in one atomic step (PluginWebhookDayCap) and is
    // kept by the id of the delivery, so a retry of a delivery that began finds its place and goes, while a retry of one that never
    // took a place (Redis failed on its first try) must take one now: no try passes the cap on the strength of its number. Deliveries
    // at the same instant cannot pass the cap together.
    const cap = manifestMaxWebhooksPerDay(installation.plugin.manifest)
    if (
      !final &&
      cap !== null &&
      !(await this.dayCap.take(installationId, deliveryId, cap, now()))
    ) {
      // Said in the log the owner reads (`attempt: 0`, which is no delivery), so a capped event is told from one the endpoint did
      // not get
      await this.guarded(storeId, installationId, () =>
        this.jobContext.forStore(storeId, async () => {
          await this.prisma.client.webhookDelivery.create({
            data: {
              pluginInstallationId: installationId,
              event,
              statusCode: null,
              durationMs: 0,
              success: false,
              error: WebhookLimits.DAILY_CAP_REACHED_CODE,
              attempt: 0
            }
          })
        })
      )
      return WebhookOutcome.SKIPPED
    }

    const startedAt = now()
    let statusCode: number
    try {
      const secret = openSecret(this.cipher, sealed)
      statusCode = await sendSigned({
        url: endpoint,
        secret,
        event,
        deliveryId,
        payload,
        signatureHeader: manifest?.signatureHeader ?? WebhookHeaders.SIGNATURE,
        correlationId: job.correlationId,
        post,
        now
      })
    } catch (error) {
      const failure = failureOf(error)
      // A delivery is one failure of the installation when it is over: when no try is left, or when no try would help
      const over = !failure.retryable || attempt >= maxAttempts
      // The last delivery of a revoked installation is logged and counts toward nothing: there is no webhook left to turn off
      const disabled = await this.recorder.failure(binding, storeId, {
        failure,
        event,
        durationMs: now() - startedAt,
        attempt,
        over,
        countless: final
      })
      if (final && over) await this.closeSubscription(installationId, storeId)
      // Turned off: the rest of the retries of this delivery would go nowhere
      if (disabled || !failure.retryable) return WebhookOutcome.FAILED_FOR_GOOD
      throw error
    }
    // Outside the try: the endpoint took the delivery, and a failure to write that down must not send it again nor count as one
    // that failed
    try {
      await this.recorder.success(binding, storeId, {
        event,
        statusCode,
        durationMs: now() - startedAt,
        attempt
      })
    } catch (error) {
      this.logger.error(
        { installationId, err: String(error) },
        'a plugin delivery was made and could not be logged'
      )
    }
    if (final) await this.closeSubscription(installationId, storeId)
    return WebhookOutcome.DELIVERED
  }

  // The subscription of a revoked installation ends with its last delivery: no address, no secret. Only while it is still revoked.
  private async closeSubscription(installationId: string, storeId: string): Promise<void> {
    // Its own guard: the delivery is over, and a failure to write that down must not send the last webhook again. The failure is
    // said in the logs; a revoked row that still holds its secret is Step 7.3's nightly sweep (plan, debt (l) of PR P3).
    try {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.pluginInstallation.updateMany({
          where: { id: installationId, storeId, status: PluginInstallationStatus.REVOKED },
          data: { webhookEndpoint: null, webhookSecret: null }
        })
      )
    } catch (error) {
      this.logger.error(
        { installationId, err: String(error) },
        'the subscription of a revoked plugin could not be closed'
      )
    }
  }

  // An installation deleted while its delivery ran has no log to write to: the recorder says whether that is the end of it
  private async guarded(
    storeId: string,
    installationId: string,
    work: () => Promise<void>
  ): Promise<void> {
    await this.recorder.guarded(this.bindingOf(storeId, installationId, ''), storeId, work)
  }

  // The installation, for the recorder: its log, its count of failures in a row and how its webhooks are turned off
  private bindingOf(storeId: string, installationId: string, pluginId: string): DeliveryBinding {
    return {
      target: WebhookMetricTarget.PLUGIN,
      noun: 'a plugin installation',
      disabledMessage: 'the webhooks of a plugin were turned off after repeated failures',
      logFields: { installationId },
      // The installation is looked up with no filter on its state (a revoked or disabled one still exists): only its absence is a
      // deletion
      exists: async () => {
        const row = await this.jobContext.forStore(storeId, () =>
          this.prisma.client.pluginInstallation.findFirst({
            where: { id: installationId, storeId },
            select: { id: true }
          })
        )
        return row !== null
      },
      writeSuccess: async row => {
        await this.prisma.client.webhookDelivery.create({
          data: { pluginInstallationId: installationId, ...row }
        })
        // The count is written only when there is something to clear: a healthy installation costs one insert
        await this.prisma.client.pluginInstallation.updateMany({
          where: { id: installationId, storeId, webhookConsecutiveFailures: { gt: 0 } },
          data: { webhookConsecutiveFailures: 0 }
        })
      },
      writeFailureRow: async (tx, row) => {
        await tx.webhookDelivery.create({ data: { pluginInstallationId: installationId, ...row } })
      },
      markFailure: async (tx, counts) => {
        const updated = await tx.pluginInstallation.update({
          where: { id: installationId, storeId },
          data: {
            webhookLastFailureAt: new Date(),
            ...(counts ? { webhookConsecutiveFailures: { increment: 1 } } : {})
          },
          select: { webhookConsecutiveFailures: true }
        })
        return updated.webhookConsecutiveFailures
      },
      turnOff: async (tx, consecutiveFailures) => {
        const turnedOff = await tx.pluginInstallation.updateMany({
          where: {
            id: installationId,
            storeId,
            status: PluginInstallationStatus.ACTIVE,
            webhookDisabledAt: null
          },
          data: { webhookDisabledAt: new Date() }
        })
        if (turnedOff.count === 0) return false
        this.events.publish(tx, Events.PLUGIN_ERROR, {
          storeId,
          installationId,
          pluginId,
          consecutiveFailures
        })
        return true
      }
    }
  }
}

function pluginHoldsScopeOf(event: string, granted: readonly string[]): boolean {
  const needed = PluginEventScopes[event]
  return needed !== undefined && granted.includes(needed)
}
