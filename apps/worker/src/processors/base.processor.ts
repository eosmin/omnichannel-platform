import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'

import { JobContextGoneError, JobContextMismatchError } from '@platform/core/database'
import {
  hasPayloadLimit,
  jobPayloadFits,
  type BaseJob,
  type QueueName
} from '@platform/core/queues'

import type { ProcessorSupport } from './processor-support'

// The attempt that is running is the last one the job has: what it cannot do now it will not do
export function isLastAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1)
}

// A processor names its queue and implements handle(); logging, metrics and the dead-letter routing
// are inherited. @Processor() goes on the subclass, where the concurrency of the queue is.
export abstract class BaseProcessor<T extends BaseJob> extends WorkerHost {
  protected constructor(
    private readonly queue: QueueName,
    private readonly support: ProcessorSupport
  ) {
    super()
  }

  protected abstract handle(job: Job<T>): Promise<void>

  async process(job: Job<T>): Promise<void> {
    // Before any schema reads the payload: one that is past the limit of its queue will not shrink when it is tried again. The error
    // names the queue's limit and never what the job held.
    if (hasPayloadLimit(this.queue) && !jobPayloadFits(job.data, this.queue)) {
      throw new UnrecoverableError('the job payload is larger than its queue allows')
    }
    try {
      await this.support.run(this.queue, job, current => this.handle(current))
    } catch (error) {
      // A payload that names a store that is not the one of its row will not fit when it is tried again either
      if (error instanceof JobContextMismatchError) throw new UnrecoverableError(error.message)
      throw error
    }
  }

  // For a job that does only one thing to one store, organization or person: if that subject was deleted after the job was queued
  // there is nothing left to do, so the job is done (with a warning). Only around the entry of the work: a handler that is half way
  // (a file uploaded, a row marked) must see the failure and close its job on the last try.
  protected async skipIfGone(job: Job<T>, work: () => Promise<unknown>): Promise<void> {
    try {
      await work()
    } catch (error) {
      if (!(error instanceof JobContextGoneError)) throw error
      this.support.subjectGone(this.queue, job, error)
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.support.completed(this.queue, job)
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    await this.support.failedAttempt(this.queue, job, error)
  }
}
