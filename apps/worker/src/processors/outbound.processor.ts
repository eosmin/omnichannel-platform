import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  JobNames,
  QueueNames,
  type SendOutboundMessageJob,
  type SendOutboundReactionJob
} from '@platform/core/queues'

import { OutboundSender } from '../outbound/outbound-sender.service'
import { ReactionSender } from '../outbound/reaction-sender.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

const jobSchema = z.object({ storeId: z.uuid(), messageId: z.uuid() })
const reactionJobSchema = jobSchema.extend({ userId: z.uuid(), version: z.number().int() })

// The worker half of a reply. What a plugin or the network can do wrong is decided by OutboundSender;
// this only turns "try again" into BullMQ's retry (5 attempts, backoff from 5 seconds).
@Processor(QueueNames.OUTBOUND, { concurrency: 20 })
export class OutboundProcessor extends BaseProcessor<
  SendOutboundMessageJob | SendOutboundReactionJob
> {
  constructor(
    support: ProcessorSupport,
    private readonly sender: OutboundSender,
    private readonly reactions: ReactionSender
  ) {
    super(QueueNames.OUTBOUND, support)
  }

  protected async handle(
    job: Job<SendOutboundMessageJob | SendOutboundReactionJob>
  ): Promise<void> {
    if (job.name === JobNames.SEND_OUTBOUND_REACTION) {
      await this.handleReaction(job)
      return
    }
    // A name this queue does not know is no reply: it would otherwise be sent as one
    if (job.name !== JobNames.SEND_OUTBOUND_MESSAGE) {
      throw new UnrecoverableError('the outbound queue does not know this job')
    }
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

  private async handleReaction(
    job: Job<SendOutboundMessageJob | SendOutboundReactionJob>
  ): Promise<void> {
    const parsed = reactionJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the reaction job does not fit its schema')
    const attempts = job.opts.attempts ?? 1
    await this.reactions.send(parsed.data, job.attemptsMade + 1 >= attempts)
  }
}
