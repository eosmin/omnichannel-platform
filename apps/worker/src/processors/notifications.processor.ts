import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'

import { JobContext } from '@platform/core/database'
import {
  type CheckRemittancesJob,
  checkRemittancesJobSchema,
  JobNames,
  QueueNames,
  type QueueEmailDigestJob,
  queueEmailDigestJobSchema,
  type SendEmailDigestJob,
  sendEmailDigestJobSchema,
  type SendWebPushJob,
  sendWebPushJobSchema
} from '@platform/core/queues'

import { EmailDigestService } from '../notifications/email-digest.service'
import { RemittanceChecker } from '../notifications/remittance-checker.service'
import { WebPushSender } from '../notifications/web-push-sender.service'

import { BaseProcessor } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import { ProcessorSupport } from './processor-support'

type NotificationsJob =
  SendWebPushJob | QueueEmailDigestJob | SendEmailDigestJob | CheckRemittancesJob

// Web push and the email of the notifications (TDD_06 §6.4, §7.1)
@Processor(QueueNames.NOTIFICATIONS, { concurrency: 10 })
export class NotificationsProcessor extends BaseProcessor<NotificationsJob> {
  constructor(
    support: ProcessorSupport,
    private readonly push: WebPushSender,
    private readonly digest: EmailDigestService,
    private readonly remittances: RemittanceChecker,
    private readonly jobContext: JobContext
  ) {
    super(QueueNames.NOTIFICATIONS, support)
  }

  protected async handle(job: Job<NotificationsJob>): Promise<void> {
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    switch (job.name) {
      case JobNames.SEND_WEB_PUSH: {
        const parsed = sendWebPushJobSchema.safeParse(job.data)
        if (!parsed.success) throw new JobRejectedError('the web push job does not fit its schema')
        await this.push.send(parsed.data.userId, parsed.data.notificationId)
        return
      }
      case JobNames.QUEUE_EMAIL_DIGEST: {
        const parsed = queueEmailDigestJobSchema.safeParse(job.data)
        if (!parsed.success) throw new JobRejectedError('the email job does not fit its schema')
        await this.digest.handleQueued(parsed.data.userId, parsed.data.notificationId, new Date())
        return
      }
      case JobNames.SEND_EMAIL_DIGEST: {
        const parsed = sendEmailDigestJobSchema.safeParse(job.data)
        if (!parsed.success) throw new JobRejectedError('the digest job does not fit its schema')
        await this.digest.sendDigest(parsed.data.userId, parsed.data.frequency, new Date())
        return
      }
      case JobNames.CHECK_REMITTANCES: {
        const parsed = checkRemittancesJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new JobRejectedError('the remittance check does not fit its schema')
        const { storeId } = parsed.data
        await this.skipIfGone(job, () =>
          this.jobContext.forStore(storeId, () => this.remittances.check(storeId, new Date()))
        )
        return
      }
      default:
        throw new UnrecoverableError('the notifications queue does not know this job')
    }
  }
}
