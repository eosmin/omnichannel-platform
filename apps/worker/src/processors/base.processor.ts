import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq'
import type { Job } from 'bullmq'

import type { BaseJob, QueueName } from '@platform/core/queues'

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
    await this.support.run(this.queue, job, current => this.handle(current))
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
