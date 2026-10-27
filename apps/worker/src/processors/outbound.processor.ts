import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { QueueNames, type SendOutboundMessageJob } from '@platform/core/queues'

import { OutboundSender } from '../outbound/outbound-sender.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

const jobSchema = z.object({ storeId: z.uuid(), messageId: z.uuid() })

// The worker half of a reply. What a plugin or the network can do wrong is decided by OutboundSender;
// this only turns "try again" into BullMQ's retry (5 attempts, backoff from 5 seconds).
@Processor(QueueNames.OUTBOUND, { concurrency: 20 })
export class OutboundProcessor extends BaseProcessor<SendOutboundMessageJob> {
  constructor(
    support: ProcessorSupport,
    private readonly sender: OutboundSender
  ) {
    super(QueueNames.OUTBOUND, support)
  }

  protected async handle(job: Job<SendOutboundMessageJob>): Promise<void> {
    const parsed = jobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the outbound job does not fit its schema')
    const attempts = job.opts.attempts ?? 1
    await this.sender.send(
      {
        ...parsed.data,
        ...(job.data.correlationId === undefined ? {} : { correlationId: job.data.correlationId })
      },
      job.attemptsMade + 1 >= attempts
    )
  }
}
