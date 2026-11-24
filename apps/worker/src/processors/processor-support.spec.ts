import { Writable } from 'node:stream'

import type { Counter, Histogram } from '@prometheus-io/client'
import { type Job, UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import { pino } from 'pino'

import { EmailDeliveryError } from '@platform/core/email'
import { REDACTED_PATHS } from '@platform/core/logger'
import { JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'
import type { QueuesRegistry } from '@platform/core/queues-module'

import { JobRejectedError } from './job-rejected.error'
import { MailJobFailedError } from './mail-job-failure'
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

      const job = { ...jobOf(3, 3), name: JobNames.TRIGGER_WEBHOOK } as unknown as Job

      await support.failedAttempt(QueueNames.WEBHOOKS, job, new Error('provider down'))

      expect(deadLetterAdd).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({
          originalQueue: QueueNames.WEBHOOKS,
          originalJobName: JobNames.TRIGGER_WEBHOOK,
          originalJobId: '7',
          originalData: { to: 'person@example.com' },
          error: 'provider down'
        })
      )
    })

    it.each([
      ['a payload past the limit of its queue', 'the job payload is larger than its queue allows'],
      ['a payload that is not its job type', 'the webhook job does not fit its schema']
    ])('copies %s to the dead-letter queue without its data', async (_name, message) => {
      const { support, deadLetterAdd } = build()
      const job = { ...jobOf(1, 3), data: { note: 'x'.repeat(1000), to: 'person@example.com' } }

      await support.failedAttempt(
        QueueNames.WEBHOOKS,
        job as unknown as Job,
        new JobRejectedError(message)
      )

      expect(deadLetterAdd).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({ originalData: null, error: message })
      )
    })

    it('copies the email of any template without its data: its text and its links are in it', async () => {
      const { support, deadLetterAdd } = build()
      const job = {
        ...jobOf(3, 3),
        name: JobNames.SEND_EMAIL,
        data: {
          to: 'person@example.com',
          data: { url: 'https://app.example.com/dsr#token=secret' }
        }
      }

      await support.failedAttempt(
        QueueNames.EMAIL,
        job as unknown as Job,
        new Error('provider down')
      )

      expect(deadLetterAdd).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({ originalJobName: JobNames.SEND_EMAIL, originalData: null })
      )
    })

    it('copies a request for a magic link without the address that was typed', async () => {
      const { support, deadLetterAdd } = build()
      const job = {
        ...jobOf(3, 3),
        name: JobNames.REQUEST_MAGIC_LINK,
        data: { email: 'x@example.com' }
      }

      await support.failedAttempt(QueueNames.EMAIL, job as unknown as Job, new Error('db down'))

      expect(deadLetterAdd).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({
          originalJobName: JobNames.REQUEST_MAGIC_LINK,
          originalData: null
        })
      )
    })

    it('copies the email of a magic link without its address or its link', async () => {
      const { support, deadLetterAdd } = build()
      const job = {
        ...jobOf(3, 3),
        name: JobNames.SEND_EMAIL,
        data: {
          to: 'x@example.com',
          data: { url: 'https://app.example.com/auth/magic#token=secret' }
        }
      }

      await support.failedAttempt(
        QueueNames.AUTH_EMAIL,
        job as unknown as Job,
        new Error('provider down')
      )

      expect(deadLetterAdd).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({ originalQueue: QueueNames.AUTH_EMAIL, originalData: null })
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

  // What a mail provider says about a refusal can hold the address it was given. The log, the dead-letter copy and the failure that the queue
  // keeps for a job of mail must hold the name and the code of the error and nothing else. Run with the real pino and the redaction of the app.
  describe('the error of a job that sends mail', () => {
    const ADDRESS = 'victim.person@example.com'
    const smtp = Object.assign(new Error(`550 5.1.1 <${ADDRESS}>: Recipient address rejected`), {
      code: 'EENVELOPE',
      response: `550 5.1.1 <${ADDRESS}>: Recipient address rejected`,
      rejected: [ADDRESS],
      envelope: { from: 'noreply@platform.local', to: [ADDRESS] }
    })
    const resend = new Error(
      `resend rejected the email: validation_error (422) Invalid to: ${ADDRESS}`
    )

    function withRealLogger(): {
      support: ProcessorSupport
      written: () => string
      add: jest.Mock
    } {
      let written = ''
      const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          written += chunk.toString()
          done()
        }
      })
      const real = pino({ redact: { paths: [...REDACTED_PATHS], remove: true } }, stream)
      const add = jest.fn().mockResolvedValue(undefined)
      const support = new ProcessorSupport(
        { get: () => ({ add }) } as unknown as QueuesRegistry,
        { inc: jest.fn() } as unknown as Counter<string>,
        { inc: jest.fn() } as unknown as Counter<string>,
        { observe: jest.fn() } as unknown as Histogram<string>,
        {
          setContext: jest.fn(),
          info: (data: object, message: string) => real.info(data, message),
          error: (data: object, message: string) => real.error(data, message)
        } as unknown as PinoLogger
      )
      return { support, written: () => written, add }
    }

    it.each([
      ['an SMTP error', smtp, QueueNames.AUTH_EMAIL],
      ['a Resend error', resend, QueueNames.AUTH_EMAIL],
      ['an SMTP error', smtp, QueueNames.EMAIL],
      ['a Resend error', resend, QueueNames.EMAIL]
    ])(
      'keeps the address of %s on %s out of the log and the dead letter',
      async (_name, error, queue) => {
        const { support, written, add } = withRealLogger()

        await support.failedAttempt(queue, jobOf(3, 3), error)

        expect(written()).not.toContain(ADDRESS)
        expect(written()).toContain('"errorName":"Error"')
        expect(JSON.stringify(add.mock.calls)).not.toContain(ADDRESS)
        expect(add).toHaveBeenCalledWith(
          JobNames.EXHAUSTED,
          expect.objectContaining({ error: 'Error' })
        )
      }
    )

    it('keeps the address out of a job that is of the mail kind on any queue', async () => {
      const { support, written, add } = withRealLogger()

      await support.failedAttempt(QueueNames.WEBHOOKS, jobOf(3, 3), smtp)

      expect(written()).not.toContain(ADDRESS)
      expect(JSON.stringify(add.mock.calls)).not.toContain(ADDRESS)
    })

    it.each([
      ['an invitation job on the email queue', QueueNames.EMAIL, JobNames.DELIVER_INVITATION_EMAIL],
      ['a job of a name nobody knows on auth-email', QueueNames.AUTH_EMAIL, 'a-name-nobody-knows']
    ])(
      'decides by the queue when the name of the job is not one of mail: %s',
      async (_name, queue, name) => {
        const { support, written, add } = withRealLogger()
        const job = { ...jobOf(3, 3), name }

        await support.failedAttempt(queue, job as unknown as Job, smtp)

        expect(written()).not.toContain(ADDRESS)
        expect(JSON.stringify(add.mock.calls)).not.toContain(ADDRESS)
      }
    )

    it.each([QueueNames.EMAIL, QueueNames.AUTH_EMAIL])(
      'keeps the address out when the job is gone (a stalled job) on %s',
      async queue => {
        const { support, written } = withRealLogger()

        await support.failedAttempt(queue, undefined, smtp)

        expect(written()).not.toContain(ADDRESS)
      }
    )

    it('passes the fixed text of a failure of the lookup of an address, which holds no address', async () => {
      const { support, add } = withRealLogger()
      const error = new MailJobFailedError('PrismaClientKnownRequestError')

      await support.failedAttempt(QueueNames.AUTH_EMAIL, jobOf(3, 3), error)

      expect(add).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({ error: 'the mail job failed: PrismaClientKnownRequestError' })
      )
    })

    it('says what the provider refused by name and code when the error is one of ours', async () => {
      const { support, written, add } = withRealLogger()
      const error = new EmailDeliveryError('validation_error', 422)

      await support.failedAttempt(QueueNames.EMAIL, jobOf(3, 3), error)

      expect(written()).toContain('"errorName":"EmailDeliveryError"')
      expect(add).toHaveBeenCalledWith(
        JobNames.EXHAUSTED,
        expect.objectContaining({ error: error.message })
      )
    })

    it('keeps the full error in the log of a job that holds no address', async () => {
      const { support, written } = withRealLogger()
      const job = { ...jobOf(1, 3), name: JobNames.PROCESS_IMAGE }

      await support.failedAttempt(
        QueueNames.HEAVY_PROCESSING,
        job as unknown as Job,
        new Error('sharp died')
      )

      expect(written()).toContain('sharp died')
    })
  })
})
