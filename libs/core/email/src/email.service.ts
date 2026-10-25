import { Inject, Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'

import { EmailMetricStatus, MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import type { SendEmailJob } from '@platform/core/queues'

import { EMAIL_FROM, EMAIL_PROVIDER, type EmailProvider } from './email-provider'
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
    await this.provider.send({
      from: this.from,
      to: job.to,
      subject,
      html,
      text,
      tags: definedTags(job.tags), // storeId and template, echoed back by the Resend webhook
      attachments: job.attachments?.map(attachment => ({
        filename: attachment.filename,
        content: Buffer.from(attachment.contentBase64, 'base64'),
        contentType: attachment.contentType
      }))
    })
    this.emailsSent.inc({ template: job.template, status: EmailMetricStatus.SENT })
  }
}
