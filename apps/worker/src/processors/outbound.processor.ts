import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  JobNames,
  QueueNames,
  type SendOutboundDeleteJob,
  type SendOutboundEditJob,
  type SendOutboundMessageJob,
  type SendOutboundReactionJob,
  type SendOutboundReadReceiptJob
} from '@platform/core/queues'

import { MessageChangeSender } from '../outbound/message-change-sender.service'
import { OutboundSender } from '../outbound/outbound-sender.service'
import { ReactionSender } from '../outbound/reaction-sender.service'
import { ReadReceiptSender } from '../outbound/read-receipt-sender.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

type OutboundJob =
  | SendOutboundMessageJob
  | SendOutboundReactionJob
  | SendOutboundEditJob
  | SendOutboundDeleteJob
  | SendOutboundReadReceiptJob

const jobSchema = z.object({ storeId: z.uuid(), messageId: z.uuid() })
// An edit or a deletion: the `version` of the message when the agent asked
const changeJobSchema = jobSchema.extend({ version: z.number().int() })
const readReceiptJobSchema = jobSchema.extend({ conversationId: z.uuid() })
const reactionJobSchema = jobSchema.extend({ userId: z.uuid(), version: z.number().int() })

// The worker half of a reply. What a plugin or the network can do wrong is decided by OutboundSender;
// this only turns "try again" into BullMQ's retry (5 attempts, backoff from 5 seconds).
@Processor(QueueNames.OUTBOUND, { concurrency: 20 })
export class OutboundProcessor extends BaseProcessor<OutboundJob> {
  constructor(
    support: ProcessorSupport,
    private readonly sender: OutboundSender,
    private readonly reactions: ReactionSender,
    private readonly changes: MessageChangeSender,
    private readonly readReceipts: ReadReceiptSender
  ) {
    super(QueueNames.OUTBOUND, support)
  }

  protected async handle(job: Job<OutboundJob>): Promise<void> {
    if (job.name === JobNames.SEND_OUTBOUND_REACTION) {
      await this.handleReaction(job)
      return
    }
    if (job.name === JobNames.SEND_OUTBOUND_READ_RECEIPT) {
      await this.handleReadReceipt(job)
      return
    }
    if (job.name === JobNames.SEND_OUTBOUND_EDIT || job.name === JobNames.SEND_OUTBOUND_DELETE) {
      await this.handleChange(job)
      return
    }
    // A name this queue does not know is no reply: it would otherwise be sent as one
    if (job.name !== JobNames.SEND_OUTBOUND_MESSAGE) {
      throw new UnrecoverableError('the outbound queue does not know this job')
    }
    const parsed = jobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the outbound job does not fit its schema')
    await this.sender.send(
      {
        ...parsed.data,
        ...(job.data.correlationId === undefined ? {} : { correlationId: job.data.correlationId })
      },
      isLastAttempt(job)
    )
  }

  private async handleChange(job: Job<OutboundJob>): Promise<void> {
    const parsed = changeJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the change job does not fit its schema')
    if (job.name === JobNames.SEND_OUTBOUND_EDIT) {
      await this.changes.sendEdit(parsed.data, isLastAttempt(job))
    } else {
      await this.changes.sendDeletion(parsed.data, isLastAttempt(job))
    }
  }

  private async handleReadReceipt(job: Job<OutboundJob>): Promise<void> {
    const parsed = readReceiptJobSchema.safeParse(job.data)
    if (!parsed.success)
      throw new UnrecoverableError('the read receipt job does not fit its schema')
    await this.readReceipts.send(parsed.data, isLastAttempt(job))
  }

  private async handleReaction(job: Job<OutboundJob>): Promise<void> {
    const parsed = reactionJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the reaction job does not fit its schema')
    await this.reactions.send(parsed.data, isLastAttempt(job))
  }
}
