import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import {
  JobNames,
  QueueNames,
  type SendOutboundMessageJob,
  type SendOutboundReactionJob
} from '@platform/core/queues'

// The job of a reply is the reply: asked twice (the sweep finds a message the api had already queued)
// it is one job. A resend of the agent (a later step) takes the same message with another id.
export function outboundJobId(messageId: string): string {
  return `send-${messageId}`
}

// One job for each version of a reaction: a later emoji is another job, the same one is the same job
export function reactionJobId(job: SendOutboundReactionJob): string {
  return `react-${job.messageId}-${job.userId}-${job.version}`
}

// The one place that puts a stored reply on its way to the channel, for the api (right after the
// reply commits) and for the worker (the sweep of the replies that never got queued).
@Injectable()
export class OutboundQueue {
  constructor(
    @InjectQueue(QueueNames.OUTBOUND)
    private readonly queue: Queue<SendOutboundMessageJob | SendOutboundReactionJob>
  ) {}

  async enqueue(job: SendOutboundMessageJob): Promise<void> {
    await this.queue.add(JobNames.SEND_OUTBOUND_MESSAGE, job, {
      jobId: outboundJobId(job.messageId)
    })
  }

  // One job for each time the agent sets the reaction (its version): the job of an earlier emoji
  // that is still waiting finds a newer version and does nothing
  async enqueueReaction(job: SendOutboundReactionJob): Promise<void> {
    await this.queue.add(JobNames.SEND_OUTBOUND_REACTION, job, {
      jobId: reactionJobId(job)
    })
  }

  // The same as `requeue` for a reaction that is still `queued` long after it was set
  async requeueReaction(job: SendOutboundReactionJob): Promise<void> {
    await this.removeFinished(reactionJobId(job))
    await this.enqueueReaction(job)
  }

  private async removeFinished(jobId: string): Promise<void> {
    const previous = await this.queue.getJob(jobId)
    if (previous === undefined) return
    const state = await previous.getState()
    if (state === 'failed' || state === 'completed') await previous.remove()
  }

  // For a message that is still `queued` long after it was queued. A job that is waiting, delayed or
  // active is left alone (adding the same id again does nothing). One that failed for good without
  // the message being marked (the database was down on its last attempt) is the case this exists for,
  // and a completed one that left the message queued is the same: BullMQ keeps both and would ignore
  // a new job with their id, so they are removed first.
  async requeue(job: SendOutboundMessageJob): Promise<void> {
    await this.removeFinished(outboundJobId(job.messageId))
    await this.enqueue(job)
  }
}
