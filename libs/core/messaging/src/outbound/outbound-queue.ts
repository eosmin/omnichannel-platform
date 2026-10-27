import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { JobNames, QueueNames, type SendOutboundMessageJob } from '@platform/core/queues'

// The job of a reply is the reply: asked twice (the sweep finds a message the api had already queued)
// it is one job. A resend of the agent (a later step) takes the same message with another id.
export function outboundJobId(messageId: string): string {
  return `send-${messageId}`
}

// The one place that puts a stored reply on its way to the channel, for the api (right after the
// reply commits) and for the worker (the sweep of the replies that never got queued).
@Injectable()
export class OutboundQueue {
  constructor(
    @InjectQueue(QueueNames.OUTBOUND) private readonly queue: Queue<SendOutboundMessageJob>
  ) {}

  async enqueue(job: SendOutboundMessageJob): Promise<void> {
    await this.queue.add(JobNames.SEND_OUTBOUND_MESSAGE, job, {
      jobId: outboundJobId(job.messageId)
    })
  }

  // For a message that is still `queued` long after it was queued. A job that is waiting, delayed or
  // active is left alone (adding the same id again does nothing). One that failed for good without
  // the message being marked (the database was down on its last attempt) is the case this exists for,
  // and a completed one that left the message queued is the same: BullMQ keeps both and would ignore
  // a new job with their id, so they are removed first.
  async requeue(job: SendOutboundMessageJob): Promise<void> {
    const previous = await this.queue.getJob(outboundJobId(job.messageId))
    if (previous !== undefined) {
      const state = await previous.getState()
      if (state === 'failed' || state === 'completed') await previous.remove()
    }
    await this.enqueue(job)
  }
}
