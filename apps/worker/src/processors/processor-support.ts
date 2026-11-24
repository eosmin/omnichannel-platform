import { Injectable } from '@nestjs/common'
import type { Counter, Histogram } from '@prometheus-io/client'
import { type Job, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { EmailDeliveryError } from '@platform/core/email'
import { errorName } from '@platform/core/errors'
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

import { JobRejectedError } from './job-rejected.error'
import { MailJobFailedError } from './mail-job-failure'

const MS_PER_SECOND = 1000

// Jobs whose data is an address typed by whoever asked, account or not, or an email with its text and its links (a data subject request's
// verification link holds a token): the dead-letter copy keeps the name, the id and the error, never the data. Neither is replayed from the
// dead-letter queue (nothing reads `originalData` back; TDD_07 §4's replay is not built and must not replay these).
// The queues whose jobs are mail: whatever their name, an error of theirs may hold the address
const MAIL_QUEUES: ReadonlySet<string> = new Set([QueueNames.AUTH_EMAIL, QueueNames.EMAIL])

const REDACTED_JOBS: ReadonlySet<string> = new Set([
  JobNames.REQUEST_MAGIC_LINK,
  JobNames.SEND_EMAIL
])

// What can be said of the failure of a job that carries an address: the text of an error we made ourselves to be safe (a job refused on entry, a
// mail the provider did not take), and for any other the name of what was thrown
function safeFailureText(error: Error): string {
  return error instanceof JobRejectedError ||
    error instanceof EmailDeliveryError ||
    error instanceof MailJobFailedError
    ? error.message
    : errorName(error)
}

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

  // A job whose store, organization or person is gone ends here as done: it is said once, not counted as a failure
  subjectGone(queue: QueueName, job: Job, error: Error): void {
    this.logger.warn(
      { queue, jobId: job.id, job: job.name, reason: error.message },
      'the subject of a job was deleted; the job is done'
    )
  }

  // A job that no longer has anything to do (its link died while it waited for the provider): it is done, said once, with a reason that
  // names no address and no link
  stale(queue: QueueName, job: Job, reason: string): void {
    this.logger.info({ queue, jobId: job.id, job: job.name, reason }, 'a job was dropped as stale')
  }

  completed(queue: QueueName, job: Job): void {
    this.processed.inc({ queue, job: job.name })
  }

  async failedAttempt(queue: QueueName, job: Job | undefined, error: Error): Promise<void> {
    this.failed.inc({ queue, job: job?.name ?? 'unknown' })
    // A job that sends mail holds an address, and what a provider says about a refusal can hold it too: its failure is the name and what is
    // safe to say about it, never the error itself (its message, stack and properties would reach the log and the dead-letter queue)
    const carriesAddress =
      MAIL_QUEUES.has(queue) || (job !== undefined && REDACTED_JOBS.has(job.name))
    if (carriesAddress) {
      this.logger.error(
        { queue, jobId: job?.id, attempt: job?.attemptsMade, errorName: errorName(error) },
        'job failed'
      )
    } else {
      this.logger.error(
        { queue, jobId: job?.id, attempt: job?.attemptsMade, err: error },
        'job failed'
      )
    }
    if (job === undefined || !isFinalFailure(job, error)) return

    const exhausted: DeadLetterJob = {
      originalQueue: queue,
      originalJobName: job.name as JobName, // Job.name is a string; only our own producers add jobs to these queues
      originalJobId: job.id,
      // Every job of the auth-email queue holds an address, and the email of a link holds the link: none is kept in the dead-letter queue
      originalData:
        REDACTED_JOBS.has(job.name) ||
        queue === QueueNames.AUTH_EMAIL ||
        // A payload the processor refused on entry (too large, or not its job type) is not copied: it may be of any size and shape
        error instanceof JobRejectedError
          ? null
          : job.data,
      error: carriesAddress ? safeFailureText(error) : error.message,
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
