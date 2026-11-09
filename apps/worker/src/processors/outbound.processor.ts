import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'

import {
  JobNames,
  outboundCaptionJobSchema,
  outboundDeleteJobSchema,
  outboundEditJobSchema,
  outboundMessageJobSchema,
  outboundReactionJobSchema,
  outboundReadReceiptJobSchema,
  outboundTypingJobSchema,
  QueueNames,
  type SendOutboundCaptionJob,
  type SendOutboundDeleteJob,
  type SendOutboundEditJob,
  type SendOutboundMessageJob,
  type SendOutboundReactionJob,
  type SendOutboundReadReceiptJob,
  type SendOutboundTypingJob
} from '@platform/core/queues'

import { MessageChangeSender } from '../outbound/message-change-sender.service'
import { outboundBackoff } from '../outbound/outbound-backoff'
import { OutboundSender } from '../outbound/outbound-sender.service'
import { ReactionSender } from '../outbound/reaction-sender.service'
import { ReadReceiptSender } from '../outbound/read-receipt-sender.service'
import { TypingSender } from '../outbound/typing-sender.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

type OutboundJob =
  | SendOutboundMessageJob
  | SendOutboundReactionJob
  | SendOutboundEditJob
  | SendOutboundDeleteJob
  | SendOutboundCaptionJob
  | SendOutboundReadReceiptJob
  | SendOutboundTypingJob

// The worker half of a reply. What a plugin or the network can do wrong is decided by OutboundSender;
// this only turns "try again" into BullMQ's retry (5 attempts, backoff from 5 seconds, from 30 when the provider throttled).
@Processor(QueueNames.OUTBOUND, {
  concurrency: 20,
  settings: { backoffStrategy: outboundBackoff }
})
export class OutboundProcessor extends BaseProcessor<OutboundJob> {
  constructor(
    support: ProcessorSupport,
    private readonly sender: OutboundSender,
    private readonly reactions: ReactionSender,
    private readonly changes: MessageChangeSender,
    private readonly readReceipts: ReadReceiptSender,
    private readonly typing: TypingSender
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
    if (job.name === JobNames.SEND_OUTBOUND_TYPING) {
      await this.handleTyping(job)
      return
    }
    if (
      job.name === JobNames.SEND_OUTBOUND_EDIT ||
      job.name === JobNames.SEND_OUTBOUND_DELETE ||
      job.name === JobNames.SEND_OUTBOUND_CAPTION
    ) {
      await this.handleChange(job)
      return
    }
    // A name this queue does not know is no reply: it would otherwise be sent as one
    if (job.name !== JobNames.SEND_OUTBOUND_MESSAGE) {
      throw new UnrecoverableError('the outbound queue does not know this job')
    }
    const parsed = outboundMessageJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the outbound job does not fit its schema')
    await this.sender.send(parsed.data, isLastAttempt(job))
  }

  private async handleChange(job: Job<OutboundJob>): Promise<void> {
    const unfit = (): UnrecoverableError =>
      new UnrecoverableError('the change job does not fit its schema')
    if (job.name === JobNames.SEND_OUTBOUND_EDIT) {
      const parsed = outboundEditJobSchema.safeParse(job.data)
      if (!parsed.success) throw unfit()
      await this.changes.sendEdit(parsed.data, isLastAttempt(job))
    } else if (job.name === JobNames.SEND_OUTBOUND_CAPTION) {
      const parsed = outboundCaptionJobSchema.safeParse(job.data)
      if (!parsed.success) throw unfit()
      await this.changes.sendCaption(parsed.data, isLastAttempt(job))
    } else {
      const parsed = outboundDeleteJobSchema.safeParse(job.data)
      if (!parsed.success) throw unfit()
      await this.changes.sendDeletion(parsed.data, isLastAttempt(job))
    }
  }

  private async handleReadReceipt(job: Job<OutboundJob>): Promise<void> {
    const parsed = outboundReadReceiptJobSchema.safeParse(job.data)
    if (!parsed.success)
      throw new UnrecoverableError('the read receipt job does not fit its schema')
    await this.readReceipts.send(parsed.data, isLastAttempt(job))
  }

  private async handleTyping(job: Job<OutboundJob>): Promise<void> {
    const parsed = outboundTypingJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the typing job does not fit its schema')
    await this.typing.send(parsed.data)
  }

  private async handleReaction(job: Job<OutboundJob>): Promise<void> {
    const parsed = outboundReactionJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the reaction job does not fit its schema')
    await this.reactions.send(parsed.data, isLastAttempt(job))
  }
}
