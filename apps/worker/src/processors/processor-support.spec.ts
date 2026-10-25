import type { Counter, Histogram } from '@prometheus-io/client'
import { type Job, UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import { JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'
import type { QueuesRegistry } from '@platform/core/queues-module'

import { ProcessorSupport } from './processor-support'

interface Harness {
  support: ProcessorSupport
  deadLetterAdd: jest.Mock
  failed: jest.Mock
  processed: jest.Mock
  observe: jest.Mock
  logError: jest.Mock
}

function build(): Harness {
  const deadLetterAdd = jest.fn().mockResolvedValue(undefined)
  const failed = jest.fn()
  const processed = jest.fn()
  const observe = jest.fn()
  const logError = jest.fn()
  const support = new ProcessorSupport(
    { get: () => ({ add: deadLetterAdd }) } as unknown as QueuesRegistry,
    { inc: processed } as unknown as Counter<string>,
    { inc: failed } as unknown as Counter<string>,
    { observe } as unknown as Histogram<string>,
    { setContext: jest.fn(), info: jest.fn(), error: logError } as unknown as PinoLogger
  )
  return { support, deadLetterAdd, failed, processed, observe, logError }
}

// The part of a BullMQ job that the support reads
function jobOf(attemptsMade: number, attempts: number): Job {
  return {
    id: '7',
    name: JobNames.SEND_EMAIL,
    attemptsMade,
    opts: { attempts },
    data: { to: 'person@example.com' }
  } as unknown as Job
}

describe('ProcessorSupport', () => {
  describe('failedAttempt', () => {
    it('counts the failed attempt and keeps the job out of the dead-letter queue while it will be retried', async () => {
      const { support, deadLetterAdd, failed } = build()

      await support.failedAttempt(QueueNames.EMAIL, jobOf(1, 3), new Error('provider down'))

      expect(failed).toHaveBeenCalledWith({ queue: 'email', job: JobNames.SEND_EMAIL })
      expect(deadLetterAdd).not.toHaveBeenCalled()
    })

    it('copies the job to the dead-letter queue on its last attempt', async () => {
      const { support, deadLetterAdd } = build()

      await support.failedAttempt(QueueNames.EMAIL, jobOf(3, 3), new Error('provider down'))

      expect(deadLetterAdd).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({
          originalQueue: QueueNames.EMAIL,
          originalJobName: JobNames.SEND_EMAIL,
          originalJobId: '7',
          originalData: { to: 'person@example.com' },
          error: 'provider down'
        })
      )
    })

    it('copies a job that can never succeed at once, without waiting for its attempts', async () => {
      const { support, deadLetterAdd } = build()

      await support.failedAttempt(
        QueueNames.EMAIL,
        jobOf(1, 3),
        new UnrecoverableError('bad payload')
      )

      expect(deadLetterAdd).toHaveBeenCalledTimes(1)
    })

    it('treats a job without attempts as a single attempt', async () => {
      const { support, deadLetterAdd } = build()
      const once = { ...jobOf(1, 1), opts: {} } as unknown as Job

      await support.failedAttempt(QueueNames.EMAIL, once, new Error('boom'))

      expect(deadLetterAdd).toHaveBeenCalledTimes(1)
    })

    it('counts a failure that has no job, and has nothing to copy', async () => {
      const { support, deadLetterAdd, failed } = build()

      await support.failedAttempt(QueueNames.EMAIL, undefined, new Error('boom'))

      expect(failed).toHaveBeenCalledWith({ queue: 'email', job: 'unknown' })
      expect(deadLetterAdd).not.toHaveBeenCalled()
    })

    it('logs and resolves when the dead-letter copy fails, so no rejection escapes the BullMQ listener', async () => {
      const { support, deadLetterAdd, logError } = build()
      deadLetterAdd.mockRejectedValue(new Error('redis down'))

      await expect(
        support.failedAttempt(QueueNames.EMAIL, jobOf(3, 3), new Error('provider down'))
      ).resolves.toBeUndefined()

      expect(logError).toHaveBeenLastCalledWith(
        expect.objectContaining({ queue: 'email', jobId: '7' }),
        'could not copy the exhausted job to the dead-letter queue'
      )
    })

    it('never logs the data of the job', async () => {
      const { support, logError } = build()

      await support.failedAttempt(QueueNames.EMAIL, jobOf(1, 3), new Error('provider down'))

      expect(JSON.stringify(logError.mock.calls)).not.toContain('person@example.com')
    })
  })

  describe('run', () => {
    const job = { id: '1', name: JobNames.SEND_EMAIL, data: {} } as unknown as Job<SendEmailJob>

    it('runs the handler and observes how long it took', async () => {
      const { support, observe } = build()
      const handle = jest.fn().mockResolvedValue(undefined)

      await support.run(QueueNames.EMAIL, job, handle)

      expect(handle).toHaveBeenCalledWith(job)
      expect(observe).toHaveBeenCalledWith(
        { queue: 'email', job: JobNames.SEND_EMAIL },
        expect.any(Number)
      )
    })

    it('lets the error of the handler through, so the queue retries, and records no duration', async () => {
      const { support, observe } = build()

      await expect(
        support.run(QueueNames.EMAIL, job, () => Promise.reject(new Error('provider down')))
      ).rejects.toThrow('provider down')

      expect(observe).not.toHaveBeenCalled()
    })
  })

  it('counts a completed job per queue and job name', () => {
    const { support, processed } = build()

    support.completed(QueueNames.EMAIL, jobOf(1, 3))

    expect(processed).toHaveBeenCalledWith({ queue: 'email', job: JobNames.SEND_EMAIL })
  })
})
