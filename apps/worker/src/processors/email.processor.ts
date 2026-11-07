import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import { EmailService } from '@platform/core/email'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import {
  JobNames,
  QueueNames,
  type RequestMagicLinkJob,
  type SendEmailJob
} from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

@Processor(QueueNames.EMAIL, {
  concurrency: 10,
  limiter: { max: 100, duration: 1000 } // Respect the provider's rate limit
})
export class EmailProcessor extends BaseProcessor<SendEmailJob | RequestMagicLinkJob> {
  constructor(
    support: ProcessorSupport,
    private readonly email: EmailService,
    private readonly magicLinks: MagicLinkIssuer
  ) {
    super(QueueNames.EMAIL, support)
  }

  protected async handle(job: Job<SendEmailJob | RequestMagicLinkJob>): Promise<void> {
    switch (job.name) {
      case JobNames.REQUEST_MAGIC_LINK: {
        const { email, correlationId } = job.data as RequestMagicLinkJob
        await this.magicLinks.issue(email, correlationId)
        return
      }
      case JobNames.SEND_EMAIL:
        await this.sendEmail(job.data as SendEmailJob)
        return
      default:
        // Never read an unknown job as an email: it would only fail the template and be retried
        throw new UnrecoverableError(`the email queue has no job named ${job.name}`)
    }
  }

  private async sendEmail(data: SendEmailJob): Promise<void> {
    try {
      await this.email.send(data)
    } catch (error) {
      // A payload the template rejects will be rejected again: retrying it only delays the dead letter
      if (error instanceof ZodError) throw new UnrecoverableError(error.message)
      throw error
    }
  }
}
