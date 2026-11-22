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
  type SendEmailJob
} from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
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
        const { email, correlationId } = job.data as RequestMagicLinkJob
        await this.magicLinks.issue(email, correlationId)
        return
      }
      case JobNames.SEND_EMAIL:
        try {
          await this.email.send(job.data as SendEmailJob)
        } catch (error) {
          // A payload the template rejects will be rejected again: retrying it only delays the dead letter
          if (error instanceof ZodError) throw new UnrecoverableError(error.message)
          throw error
        }
        return
      default:
        throw new UnrecoverableError(`the auth email queue has no job named ${job.name}`)
    }
  }
}
