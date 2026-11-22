import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import { EmailService } from '@platform/core/email'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import {
  AuthEmailQueue,
  JobNames,
  QueueNames,
  type RequestMagicLinkJob,
  requestMagicLinkJobSchema,
  type SendEmailJob,
  sendEmailJobSchema
} from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import { ProcessorSupport } from './processor-support'

// The worker half of the magic link, on a queue of its own (Step 7.3-S9): the lookup of the address and the email that follows. It shares
// nothing with the general email queue, so a burst of digests, scheduled reports or invitation emails never delays a login.
@Processor(QueueNames.AUTH_EMAIL, {
  concurrency: AuthEmailQueue.CONCURRENCY,
  limiter: { max: AuthEmailQueue.LIMIT_MAX, duration: AuthEmailQueue.LIMIT_DURATION_MS }
})
export class AuthEmailProcessor extends BaseProcessor<RequestMagicLinkJob | SendEmailJob> {
  constructor(
    support: ProcessorSupport,
    private readonly email: EmailService,
    private readonly magicLinks: MagicLinkIssuer
  ) {
    super(QueueNames.AUTH_EMAIL, support)
  }

  protected async handle(job: Job<RequestMagicLinkJob | SendEmailJob>): Promise<void> {
    switch (job.name) {
      case JobNames.REQUEST_MAGIC_LINK: {
        const parsed = requestMagicLinkJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new JobRejectedError('the magic link job does not fit its schema')
        await this.magicLinks.issue(parsed.data.email, parsed.data.correlationId)
        return
      }
      case JobNames.SEND_EMAIL: {
        const parsed = sendEmailJobSchema.safeParse(job.data)
        if (!parsed.success) throw new JobRejectedError('the email job does not fit its schema')
        try {
          await this.email.send(parsed.data)
        } catch (error) {
          // A payload the template rejects will be rejected again: retrying it only delays the dead letter
          if (error instanceof ZodError)
            throw new JobRejectedError('the email data does not fit its template')
          throw error
        }
        return
      }
      default:
        throw new UnrecoverableError('the auth email queue does not know this job')
    }
  }
}
