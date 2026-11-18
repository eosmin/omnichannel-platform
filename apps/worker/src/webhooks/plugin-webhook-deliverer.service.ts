import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
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
import {
  type DeliveryDeps,
  type Failure,
  failureOf,
  isGone,
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly events: DomainEvents,
    @InjectMetric(MetricNames.WEBHOOK_DELIVERIES) private readonly deliveries: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginWebhookDeliverer.name)
  }

  // Throws the failure that BullMQ should retry; returns for everything that is final
  async deliver(
    job: TriggerPluginWebhookJob,
    attempt: number,
    { post = pinnedHttpsPost, now = Date.now, maxAttempts = 1 }: DeliveryDeps = {}
  ): Promise<WebhookOutcome> {
    const { pluginInstallationId: installationId, storeId, event, payload, deliveryId } = job
    const final = job.final === true
    const installation = await this.prisma.client.pluginInstallation.findFirst({
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
    if (installation === null) return WebhookOutcome.SKIPPED
    const { webhookEndpoint: endpoint, webhookSecret: sealed } = installation
    const manifest = manifestWebhookOf(installation.plugin.manifest)
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
    // The cap of the day the plugin declared (`limits.maxWebhooksPerDay`). Only the first try of a delivery is held to it: a
    // delivery that began is finished, and the last one of a revocation always goes. What is over the cap is dropped, not failed:
    // it is not the endpoint's fault, so it counts toward turning nothing off. The cap is on deliveries STARTED: a first try
    // that fails is one of them (its retries are not). The count and the send are not one step, so deliveries at the same
    // instant may pass the cap by the number that raced (plan: debt of the PR of PLG-256).
    const cap = manifestMaxWebhooksPerDay(installation.plugin.manifest)
    if (!final && attempt <= 1 && cap !== null) {
      const today = await this.prisma.client.webhookDelivery.count({
        where: {
          pluginInstallationId: installationId,
          attempt: 1,
          createdAt: { gte: new Date(now() - WebhookLimits.PLUGIN_DAY_MS) }
        }
      })
      if (today >= cap) {
        // Said in the log the owner reads (`attempt: 0`, which the count above never takes for a delivery), so a capped event is
        // told from one the endpoint did not get
        await this.guarded(installationId, async () => {
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
        return WebhookOutcome.SKIPPED
      }
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
      const disabled = await this.recordFailure(job, installation.pluginId, {
        failure,
        durationMs: now() - startedAt,
        attempt,
        over,
        final
      })
      if (final && over) await this.closeSubscription(installationId, storeId)
      // Turned off: the rest of the retries of this delivery would go nowhere
      if (disabled || !failure.retryable) return WebhookOutcome.FAILED_FOR_GOOD
      throw error
    }
    // Outside the try: the endpoint took the delivery, and a failure to write that down must not send it again nor count as one
    // that failed
    try {
      await this.recordSuccess(
        installationId,
        storeId,
        event,
        statusCode,
        now() - startedAt,
        attempt
      )
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
      await this.prisma.client.pluginInstallation.updateMany({
        where: { id: installationId, storeId, status: PluginInstallationStatus.REVOKED },
        data: { webhookEndpoint: null, webhookSecret: null }
      })
    } catch (error) {
      this.logger.error(
        { installationId, err: String(error) },
        'the subscription of a revoked plugin could not be closed'
      )
    }
  }

  private async recordSuccess(
    installationId: string,
    storeId: string,
    event: string,
    statusCode: number,
    durationMs: number,
    attempt: number
  ): Promise<void> {
    this.deliveries.inc({ target: WebhookMetricTarget.PLUGIN, success: 'true' })
    await this.guarded(installationId, async () => {
      await this.prisma.client.webhookDelivery.create({
        data: {
          pluginInstallationId: installationId,
          event,
          statusCode,
          durationMs,
          success: true,
          attempt
        }
      })
      // The count is written only when there is something to clear: a healthy installation costs one insert
      await this.prisma.client.pluginInstallation.updateMany({
        where: { id: installationId, storeId, webhookConsecutiveFailures: { gt: 0 } },
        data: { webhookConsecutiveFailures: 0 }
      })
    })
  }

  // True when this failure was the one that turned the installation's webhooks off
  private async recordFailure(
    job: TriggerPluginWebhookJob,
    pluginId: string,
    result: { failure: Failure; durationMs: number; attempt: number; over: boolean; final: boolean }
  ): Promise<boolean> {
    const { pluginInstallationId: installationId, storeId, event } = job
    const { failure, durationMs, attempt, over, final } = result
    this.deliveries.inc({ target: WebhookMetricTarget.PLUGIN, success: 'false' })
    let disabled = false
    await this.guarded(installationId, async () => {
      disabled = await this.prisma.transaction(async tx => {
        await tx.webhookDelivery.create({
          data: {
            pluginInstallationId: installationId,
            event,
            statusCode: failure.status,
            durationMs,
            success: false,
            error: failure.code.slice(0, WebhookLimits.DELIVERY_ERROR_MAX_LENGTH),
            attempt
          }
        })
        // The last delivery of a revoked installation is logged and counts toward nothing: there is no webhook left to turn off
        if (final) return false
        // Every try is a row of the log; only the end of a delivery counts toward turning the webhooks off
        const updated = await tx.pluginInstallation.update({
          where: { id: installationId, storeId },
          data: {
            webhookLastFailureAt: new Date(),
            ...(over ? { webhookConsecutiveFailures: { increment: 1 } } : {})
          },
          select: { webhookConsecutiveFailures: true }
        })
        if (!over) return false
        if (updated.webhookConsecutiveFailures < WebhookLimits.MAX_CONSECUTIVE_FAILURES) {
          return false
        }
        // Only the one that changes it from delivering tells anybody: two deliveries that fail together say it once
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
          consecutiveFailures: updated.webhookConsecutiveFailures
        })
        return true
      })
    })
    if (disabled) {
      this.logger.warn(
        { installationId, storeId },
        'the webhooks of a plugin were turned off after repeated failures'
      )
    }
    return disabled
  }

  // An installation deleted while its delivery ran has no log to write to: that is the end of it, not an error to retry
  private async guarded(installationId: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      if (isGone(error)) {
        this.logger.info(
          { installationId },
          'a plugin installation was deleted while its delivery ran'
        )
        return
      }
      throw error
    }
  }
}

function pluginHoldsScopeOf(event: string, granted: readonly string[]): boolean {
  const needed = PluginEventScopes[event]
  return needed !== undefined && granted.includes(needed)
}
