import { Inject, Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'

import { errorName } from '@platform/core/errors'
import { EmailMetricStatus, MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { SendEmailJob } from '@platform/core/queues'

import { EmailDeliveryError } from './email-delivery-error'
import {
  EMAIL_FROM,
  EMAIL_PROVIDER,
  type EmailProvider,
  type SendEmailOptions
} from './email-provider'
import { TemplateRenderer } from './template-renderer'

function definedTags(tags: SendEmailJob['tags']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

@Injectable()
export class EmailService {
  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    @Inject(EMAIL_FROM) private readonly from: string,
    private readonly renderer: TemplateRenderer,
    @InjectMetric(MetricNames.EMAILS_SENT) private readonly emailsSent: Counter<string>
  ) {}

  async send(job: SendEmailJob): Promise<void> {
    // A failed attempt is not counted here: the queue counts every failed attempt
    // (platform_queue_failed_total), and status="failed" is what the provider reports afterwards
    const { subject, html, text } = await this.renderer.render(job.template, job.locale, job.data)
    await this.sendThroughProvider({
      from: this.from,
      to: job.to,
      subject,
      html,
      text,
      headers: job.headers,
      tags: definedTags(job.tags), // storeId and template, echoed back by the Resend webhook
      attachments: job.attachments?.map(attachment => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.contentBase64, 'base64'),
        contentType: attachment.contentType
      }))
    })
    this.emailsSent.inc({ template: job.template, status: EmailMetricStatus.SENT })
  }
  // A provider that refuses a mail may put the address in its text. What leaves this service is an error with the name and the code only
  // (`EmailDeliveryError`), so no log, dead letter or failure kept by the queue can hold it. A provider that already raises one passes as it is.
  private async sendThroughProvider(options: SendEmailOptions): Promise<void> {
    try {
      await this.provider.send(options)
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error
      const code: unknown =
        typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null
      throw new EmailDeliveryError(errorName(error), code)
    }
  }
}
