import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import { EmailService } from '@platform/core/email'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import {
  AuthEmailQueue,
  EmailTemplates,
  JobNames,
  QueueNames,
  type RequestMagicLinkJob,
  requestMagicLinkJobSchema,
  type SendEmailJob,
  sendEmailJobSchema
} from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import { issueMagicLinkSafely } from './mail-job-failure'
import { ProcessorSupport } from './processor-support'

// The worker half of the magic link, on a queue of its own (Step 7.3-S9): the lookup of the address and the email that follows. It shares
// nothing with the general email queue, so a burst of digests, scheduled reports or invitation emails never delays a login.
@Processor(QueueNames.AUTH_EMAIL, {
  concurrency: AuthEmailQueue.CONCURRENCY,
  limiter: { max: AuthEmailQueue.LIMIT_MAX, duration: AuthEmailQueue.LIMIT_DURATION_MS }
})
export class AuthEmailProcessor extends BaseProcessor<RequestMagicLinkJob | SendEmailJob> {
  // The base class keeps its support private; this is the same object, for the one note this processor adds
  private readonly notes: ProcessorSupport

  constructor(
    support: ProcessorSupport,
    private readonly email: EmailService,
    private readonly magicLinks: MagicLinkIssuer
  ) {
    super(QueueNames.AUTH_EMAIL, support)
    this.notes = support
  }

  protected async handle(job: Job<RequestMagicLinkJob | SendEmailJob>): Promise<void> {
    switch (job.name) {
      case JobNames.REQUEST_MAGIC_LINK: {
        const parsed = requestMagicLinkJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new JobRejectedError('the magic link job does not fit its schema')
        await issueMagicLinkSafely(this.magicLinks, parsed.data.email, parsed.data.correlationId)
        return
      }
      case JobNames.SEND_EMAIL: {
        const parsed = sendEmailJobSchema.safeParse(job.data)
        if (!parsed.success) throw new JobRejectedError('the email job does not fit its schema')
        const toSend = await this.stillUseful(parsed.data, job)
        if (toSend === null) return
        try {
          await this.email.send(toSend)
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

  // The mail of a link is tried again for as long as the provider is down (the queue waits longer after each failure), so what it said when it
  // was queued may not be true any more. A retry is sent only while the server still has that link live (not used, not replaced by a newer
  // request, not expired) with enough time left to use it, and it says the time that is left. The first attempt is as fresh as the job.
  private async stillUseful(data: SendEmailJob, job: Job): Promise<SendEmailJob | null> {
    if (job.attemptsMade <= 0 || data.template !== EmailTemplates.MAGIC_LINK) return data
    const url = data.data['url']
    const left = typeof url === 'string' ? await this.magicLinks.remainingValidityMs(url) : 0
    if (left < AuthEmailQueue.MIN_LINK_VALIDITY_MS) {
      this.notes.stale(QueueNames.AUTH_EMAIL, job, 'the magic link is no longer live')
      return null
    }
    return { ...data, data: { ...data.data, expiresInMinutes: Math.floor(left / 60_000) } }
  }
}
