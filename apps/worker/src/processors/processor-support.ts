import { Injectable } from '@nestjs/common'
import type { Counter, Histogram } from '@prometheus-io/client'
import { type Job, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  type BaseJob,
  type DeadLetterJob,
  JobNames,
  QueueNames,
  type JobName,
  type QueueName
} from '@platform/core/queues'
import { QueuesRegistry } from '@platform/core/queues-module'

const MS_PER_SECOND = 1000

// What every processor shares (TDD_07 §1.5): structured logging, the queue metrics and the route to
// the dead-letter queue once the attempts are spent.
@Injectable()
export class ProcessorSupport {
  constructor(
    private readonly queues: QueuesRegistry,
    @InjectMetric(MetricNames.QUEUE_PROCESSED) private readonly processed: Counter<string>,
    @InjectMetric(MetricNames.QUEUE_FAILED) private readonly failed: Counter<string>,
    @InjectMetric(MetricNames.QUEUE_PROCESSING_DURATION)
    private readonly duration: Histogram<string>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): that decorator only gets a provider when the class is imported
    // before LoggerModule.forRoot() runs, and in an app HttpPlatformModule runs first
    this.logger.setContext(ProcessorSupport.name)
  }

  async run<T extends BaseJob>(
    queue: QueueName,
    job: Job<T>,
    handle: (job: Job<T>) => Promise<void>
  ): Promise<void> {
    const startedAt = Date.now()
    this.logger.info(
      { queue, jobId: job.id, job: job.name, correlationId: job.data.correlationId },
      'processing job'
    )
    await handle(job)
    this.duration.observe({ queue, job: job.name }, (Date.now() - startedAt) / MS_PER_SECOND)
  }

  completed(queue: QueueName, job: Job): void {
    this.processed.inc({ queue, job: job.name })
  }

  async failedAttempt(queue: QueueName, job: Job | undefined, error: Error): Promise<void> {
    this.failed.inc({ queue, job: job?.name ?? 'unknown' })
    this.logger.error(
      { queue, jobId: job?.id, attempt: job?.attemptsMade, err: error },
      'job failed'
    )
    if (job === undefined || !isFinalFailure(job, error)) return

    const exhausted: DeadLetterJob = {
      originalQueue: queue,
      originalJobName: job.name as JobName, // Job.name is a string; only our own producers add jobs to these queues
      originalJobId: job.id,
      originalData: job.data,
      error: error.message,
      failedAt: new Date().toISOString()
    }
    try {
      await this.queues.get(QueueNames.DEAD_LETTER).add(JobNames.EXHAUSTED, exhausted)
    } catch (deadLetterError) {
      // This runs in a BullMQ event listener: a rejection here would be an unhandled one. The failed
      // job stays in its own queue (removeOnFail), so it can still be found and retried there.
      this.logger.error(
        { queue, jobId: job.id, err: deadLetterError },
        'could not copy the exhausted job to the dead-letter queue'
      )
    }
  }
}

function isFinalFailure(job: Job, error: Error): boolean {
  return error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1)
}
