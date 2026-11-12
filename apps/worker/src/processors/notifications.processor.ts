import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { DigestFrequency } from '@platform/core/domain'
import {
  type CheckRemittancesJob,
  JobNames,
  QueueNames,
  type QueueEmailDigestJob,
  type SendEmailDigestJob,
  type SendWebPushJob
} from '@platform/core/queues'

import { EmailDigestService } from '../notifications/email-digest.service'
import { RemittanceChecker } from '../notifications/remittance-checker.service'
import { WebPushSender } from '../notifications/web-push-sender.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

const notificationJobSchema = z.object({ userId: z.uuid(), notificationId: z.uuid() })
const checkRemittancesJobSchema = z.object({ storeId: z.uuid() })
const digestJobSchema = z.object({ userId: z.uuid(), frequency: z.enum(DigestFrequency) })

type NotificationsJob =
  SendWebPushJob | QueueEmailDigestJob | SendEmailDigestJob | CheckRemittancesJob

// Web push and the email of the notifications (TDD_06 §6.4, §7.1)
@Processor(QueueNames.NOTIFICATIONS, { concurrency: 10 })
export class NotificationsProcessor extends BaseProcessor<NotificationsJob> {
  constructor(
    support: ProcessorSupport,
    private readonly push: WebPushSender,
    private readonly digest: EmailDigestService,
    private readonly remittances: RemittanceChecker
  ) {
    super(QueueNames.NOTIFICATIONS, support)
  }

  protected async handle(job: Job<NotificationsJob>): Promise<void> {
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    switch (job.name) {
      case JobNames.SEND_WEB_PUSH: {
        const parsed = notificationJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new UnrecoverableError('the web push job does not fit its schema')
        await this.push.send(parsed.data.userId, parsed.data.notificationId)
        return
      }
      case JobNames.QUEUE_EMAIL_DIGEST: {
        const parsed = notificationJobSchema.safeParse(job.data)
        if (!parsed.success) throw new UnrecoverableError('the email job does not fit its schema')
        await this.digest.handleQueued(parsed.data.userId, parsed.data.notificationId, new Date())
        return
      }
      case JobNames.SEND_EMAIL_DIGEST: {
        const parsed = digestJobSchema.safeParse(job.data)
        if (!parsed.success) throw new UnrecoverableError('the digest job does not fit its schema')
        await this.digest.sendDigest(parsed.data.userId, parsed.data.frequency, new Date())
        return
      }
      case JobNames.CHECK_REMITTANCES: {
        const parsed = checkRemittancesJobSchema.safeParse(job.data)
        if (!parsed.success)
          throw new UnrecoverableError('the remittance check does not fit its schema')
        await this.remittances.check(parsed.data.storeId, new Date())
        return
      }
      default:
        throw new UnrecoverableError('the notifications queue does not know this job')
    }
  }
}
