import { InjectQueue } from '@nestjs/bullmq'
import { Controller, Headers, HttpCode, Post, type RawBodyRequest, Req } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import type { Request } from 'express'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { ProcessedWebhookEventsService } from '@platform/core/database'
import { ResendEventTypes, WebhookSources } from '@platform/core/domain'
import { ResendWebhookVerifier } from '@platform/core/email'
import { EmailMetricStatus, MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { JobNames, QueueNames, type TrackAnalyticsJob } from '@platform/core/queues'

import { hashEmail } from './hash-email'
import {
  engagementDataSchema,
  failureDataSchema,
  resendEnvelopeSchema
} from './resend-webhook.schemas'

const UNKNOWN_TEMPLATE = 'unknown'

// Public: the Svix signature of the body authenticates it (TDD_07 §5.4). Addresses that bounce are
// only logged and counted for now: the suppression list that stops sending to them is a later,
// global (not per store) table (MVP_TRIM_CHECKLIST.md, "Email build details (Step 1.0)").
@Controller()
export class ResendWebhookController {
  constructor(
    private readonly verifier: ResendWebhookVerifier,
    private readonly processedEvents: ProcessedWebhookEventsService,
    @InjectQueue(QueueNames.ANALYTICS) private readonly analyticsQueue: Queue<TrackAnalyticsJob>,
    @InjectMetric(MetricNames.EMAILS_SENT) private readonly emails: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(ResendWebhookController.name)
  }

  @Post(ApiRoutes.webhooks.resend)
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') id: string | undefined,
    @Headers('svix-timestamp') timestamp: string | undefined,
    @Headers('svix-signature') signature: string | undefined
  ): Promise<{ received: true }> {
    const verified = this.verifier.verify(req.rawBody, { id, timestamp, signature })
    const envelope = resendEnvelopeSchema.parse(verified) // Zod at the boundary, even after the signature
    const eventId = id ?? '' // verify() throws without it, so it is defined past this point

    await this.processedEvents.runOnce(WebhookSources.RESEND, eventId, envelope.type, () =>
      this.dispatch(eventId, envelope.type, envelope.data)
    )
    return { received: true }
  }

  private dispatch(eventId: string, type: string, data: unknown): Promise<void> {
    switch (type) {
      case ResendEventTypes.EMAIL_OPENED:
      case ResendEventTypes.EMAIL_CLICKED:
        return this.trackEngagement(eventId, type, data)
      case ResendEventTypes.EMAIL_BOUNCED:
        return this.recordFailure(type, EmailMetricStatus.BOUNCED, data)
      case ResendEventTypes.EMAIL_FAILED:
        return this.recordFailure(type, EmailMetricStatus.FAILED, data)
      case ResendEventTypes.EMAIL_COMPLAINED:
        return this.recordFailure(type, EmailMetricStatus.COMPLAINED, data)
      default:
        return Promise.resolve() // Delivered, sent and the rest are acknowledged and ignored
    }
  }

  // A signed event whose data we cannot read is acknowledged and logged, not failed: the retry would
  // carry the same body and fail the same way, forever, while Resend backs off for days.
  private async trackEngagement(eventId: string, type: string, data: unknown): Promise<void> {
    const parsed = engagementDataSchema.safeParse(data)
    if (!parsed.success) return this.logUnreadable(type)
    const event = parsed.data
    const storeId = event.tags?.['storeId']
    if (storeId === undefined) return // An account email (a magic link) belongs to no store
    if (!z.uuid().safeParse(storeId).success) return this.logUnreadable(type) // Never queue a junk store id
    await this.analyticsQueue.add(
      JobNames.TRACK_EVENT,
      {
        event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
        storeId,
        data: { type, template: event.tags?.['template'], messageId: event.email_id },
        timestamp: new Date().toISOString()
      },
      // The event id as job id: if the transaction fails after the add, the retry cannot queue it twice
      { jobId: eventId }
    )
  }

  private logUnreadable(type: string): void {
    this.logger.warn({ type }, 'resend event with data we cannot read was acknowledged and skipped')
  }

  private recordFailure(type: string, status: string, data: unknown): Promise<void> {
    const parsed = failureDataSchema.safeParse(data)
    if (!parsed.success) {
      this.logUnreadable(type)
      return Promise.resolve()
    }
    const event = parsed.data
    this.emails.inc({ template: event.tags?.['template'] ?? UNKNOWN_TEMPLATE, status })
    this.logger.warn(
      { type, emailHashes: event.to.map(hashEmail), template: event.tags?.['template'] },
      'email delivery problem reported by the provider'
    )
    return Promise.resolve()
  }
}
