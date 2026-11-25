import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { ZodError } from 'zod'

import { DsrFailureCodes } from '@platform/core/compliance'
import { EmailService } from '@platform/core/email'
import { errorName } from '@platform/core/errors'
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

import { DsrNoticeLedger } from '../compliance/dsr-notice-ledger.service'
import { InvitationEmailDelivery } from '../invitations/invitation-email-delivery.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import { issueMagicLinkSafely, onlyTheNameOfAFailure } from './mail-job-failure'
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
    private readonly invitations: InvitationEmailDelivery,
    private readonly notices: DsrNoticeLedger,
    private readonly logger: PinoLogger
  ) {
    super(QueueNames.EMAIL, support)
    this.logger.setContext(EmailProcessor.name)
  }

  protected handle(
    job: Job<SendEmailJob | RequestMagicLinkJob | DeliverInvitationEmailJob>
  ): Promise<void> {
    // Whatever this processor does not control (the database, a template) leaves the job as the name of the failure, never as its text
    return onlyTheNameOfAFailure(() => this.route(job))
  }

  private async route(
    job: Job<SendEmailJob | RequestMagicLinkJob | DeliverInvitationEmailJob>
  ): Promise<void> {
    switch (job.name) {
      // Rollout only (Step 7.3-S9): the magic link has its own queue now, but a job that an api of the previous release queued here is still
      // served. Remove this case one release after the worker and the api run the new code (plan, Step 7.3-S9 note)
      case JobNames.REQUEST_MAGIC_LINK: {
        const parsed = requestMagicLinkJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new JobRejectedError('the magic link job does not fit its schema')
        await issueMagicLinkSafely(this.magicLinks, parsed.data.email, parsed.data.correlationId)
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
        await this.sendEmail(parsed.data, job)
        return
      }
      default:
        // Never read an unknown job as an email: it would only fail the template and be retried
        throw new UnrecoverableError('the email queue does not know this job')
    }
  }

  private async sendEmail(data: SendEmailJob, job: Job): Promise<void> {
    try {
      await this.email.send(data)
    } catch (error) {
      // The closing notice of a data request ran out of attempts: the request says the person was never told (Step 7.2-H2b-2). Never lets
      // the bookkeeping hide the failure of the mail
      const rejected = error instanceof ZodError || error instanceof UnrecoverableError
      if (data.dsrNotice !== undefined && (rejected || isLastAttempt(job))) {
        await this.noticeFailed(data.dsrNotice)
      }
      // A payload the template rejects will be rejected again: retrying it only delays the dead letter
      if (error instanceof ZodError)
        throw new JobRejectedError('the email data does not fit its template')
      throw error
    }
    if (data.dsrNotice !== undefined) await this.noticeSent(data.dsrNotice)
  }

  // The mail left. If the request cannot be told (the database is down) the mail is NOT sent again: the sealed address stays and the sweep of
  // the night asks for the mail once more, so the person may get it twice but is never left without
  private async noticeSent(notice: { requestId: string; storeId: string }): Promise<void> {
    try {
      await this.notices.sent(notice.storeId, notice.requestId)
    } catch (error) {
      this.logger.error(
        { requestId: notice.requestId, errorName: errorName(error) },
        'the closing notice of a data request left but could not be recorded'
      )
    }
  }

  private async noticeFailed(notice: { requestId: string; storeId: string }): Promise<void> {
    try {
      await this.notices.failed(notice.storeId, notice.requestId, DsrFailureCodes.MAIL_FAILED)
    } catch (error) {
      this.logger.error(
        { requestId: notice.requestId, errorName: errorName(error) },
        'the failure of a closing notice could not be recorded'
      )
    }
  }
}
