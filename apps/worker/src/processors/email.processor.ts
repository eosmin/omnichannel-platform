import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import { EmailService } from '@platform/core/email'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import {
  type DeliverInvitationEmailJob,
  deliverInvitationEmailJobSchema,
  EmailQueue,
  JobNames,
  QueueNames,
  type RequestMagicLinkJob,
  requestMagicLinkJobSchema,
  type SendEmailJob,
  sendEmailJobSchema
} from '@platform/core/queues'

import { InvitationEmailDelivery } from '../invitations/invitation-email-delivery.service'

import { BaseProcessor } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import { ProcessorSupport } from './processor-support'

// The provider's rate limit is shared with the auth-email queue: the two limits add up to it (EmailProviderBudget)
@Processor(QueueNames.EMAIL, {
  concurrency: EmailQueue.CONCURRENCY,
  limiter: { max: EmailQueue.LIMIT_MAX, duration: EmailQueue.LIMIT_DURATION_MS }
})
export class EmailProcessor extends BaseProcessor<
  SendEmailJob | RequestMagicLinkJob | DeliverInvitationEmailJob
> {
  constructor(
    support: ProcessorSupport,
    private readonly email: EmailService,
    private readonly magicLinks: MagicLinkIssuer,
    private readonly invitations: InvitationEmailDelivery
  ) {
    super(QueueNames.EMAIL, support)
  }

  protected async handle(
    job: Job<SendEmailJob | RequestMagicLinkJob | DeliverInvitationEmailJob>
  ): Promise<void> {
    switch (job.name) {
      // Rollout only (Step 7.3-S9): the magic link has its own queue now, but a job that an api of the previous release queued here is still
      // served. Remove this case one release after the worker and the api run the new code (plan, Step 7.3-S9 note)
      case JobNames.REQUEST_MAGIC_LINK: {
        const parsed = requestMagicLinkJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new JobRejectedError('the magic link job does not fit its schema')
        await this.magicLinks.issue(parsed.data.email, parsed.data.correlationId)
        return
      }
      case JobNames.DELIVER_INVITATION_EMAIL: {
        const parsed = deliverInvitationEmailJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new JobRejectedError('the invitation job does not fit its schema')
        const { storeId, invitationId } = parsed.data
        // A failed delivery is released by the service and tried again by the sweep, so the job itself never retries
        await this.invitations.deliver(storeId, invitationId)
        return
      }
      case JobNames.SEND_EMAIL: {
        const parsed = sendEmailJobSchema.safeParse(job.data)
        if (!parsed.success) throw new JobRejectedError('the email job does not fit its schema')
        await this.sendEmail(parsed.data)
        return
      }
      default:
        // Never read an unknown job as an email: it would only fail the template and be retried
        throw new UnrecoverableError('the email queue does not know this job')
    }
  }

  private async sendEmail(data: SendEmailJob): Promise<void> {
    try {
      await this.email.send(data)
    } catch (error) {
      // A payload the template rejects will be rejected again: retrying it only delays the dead letter
      if (error instanceof ZodError)
        throw new JobRejectedError('the email data does not fit its template')
      throw error
    }
  }
}
