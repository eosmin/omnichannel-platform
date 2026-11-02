import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { JobNames, QueueNames, type SendWebPushJob } from '@platform/core/queues'

import { WebPushSender } from '../notifications/web-push-sender.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

const webPushJobSchema = z.object({ userId: z.uuid(), notificationId: z.uuid() })

// Web push now; the email digest jobs of the same queue arrive in Step 3.5 PR D
@Processor(QueueNames.NOTIFICATIONS, { concurrency: 10 })
export class NotificationsProcessor extends BaseProcessor<SendWebPushJob> {
  constructor(
    support: ProcessorSupport,
    private readonly push: WebPushSender
  ) {
    super(QueueNames.NOTIFICATIONS, support)
  }

  protected async handle(job: Job<SendWebPushJob>): Promise<void> {
    if (job.name !== JobNames.SEND_WEB_PUSH) {
      throw new UnrecoverableError('the notifications queue does not know this job')
    }
    const parsed = webPushJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the web push job does not fit its schema')
    await this.push.send(parsed.data.userId, parsed.data.notificationId)
  }
}
