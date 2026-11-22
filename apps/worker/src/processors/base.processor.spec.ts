import { type Job, UnrecoverableError } from 'bullmq'

import {
  JobContextError,
  JobContextGoneError,
  JobContextMismatchError
} from '@platform/core/database'
import { JobPayloadLimits, QueueNames } from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import type { ProcessorSupport } from './processor-support'

class Probe extends BaseProcessor<{ correlationId?: string }> {
  constructor(
    support: ProcessorSupport,
    private readonly work: () => Promise<void>,
    private readonly guarded: boolean
  ) {
    super(QueueNames.ANALYTICS, support)
  }

  protected handle(job: Job<{ correlationId?: string }>): Promise<void> {
    return this.guarded ? this.skipIfGone(job, this.work) : this.work()
  }
}

describe('BaseProcessor and the errors of the context', () => {
  const subjectGone = jest.fn()
  const support = {
    run: (_queue: string, job: Job, run: (job: Job) => Promise<void>) => run(job),
    subjectGone
  } as unknown as ProcessorSupport
  const job = { name: 'x', data: {} } as unknown as Job<{ correlationId?: string }>

  beforeEach(() => subjectGone.mockReset())

  it('ends as done, with a warning, a job whose store was deleted, when the job asked for it', async () => {
    const probe = new Probe(support, () => Promise.reject(new JobContextGoneError('gone')), true)
    await expect(probe.process(job)).resolves.toBeUndefined()
    expect(subjectGone).toHaveBeenCalledTimes(1)
  })

  it('does not end as done a gone subject that the handler met half way', async () => {
    const probe = new Probe(support, () => Promise.reject(new JobContextGoneError('gone')), false)
    await expect(probe.process(job)).rejects.toBeInstanceOf(JobContextGoneError)
    expect(subjectGone).not.toHaveBeenCalled()
  })

  it('lets any other error of the context fail the job, so that the queue retries it and its handler can close it', async () => {
    const probe = new Probe(support, () => Promise.reject(new JobContextError('hidden')), true)
    await expect(probe.process(job)).rejects.toBeInstanceOf(JobContextError)
    expect(subjectGone).not.toHaveBeenCalled()
  })

  it('does not retry a payload that is not the store of its row', async () => {
    const probe = new Probe(support, () => Promise.reject(new JobContextMismatchError('no')), false)
    await expect(probe.process(job)).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('refuses a payload past the limit of its queue before the handler reads it, and says nothing of what it held', async () => {
    const work = jest.fn(() => Promise.resolve())
    const probe = new Probe(support, work, false)
    const secret = 'customer@example.com'
    const big = {
      name: 'x',
      data: { note: secret + 'x'.repeat(JobPayloadLimits[QueueNames.ANALYTICS]) }
    } as unknown as Job<{ correlationId?: string }>

    const error: unknown = await probe.process(big).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(JobRejectedError)
    expect((error as Error).message).not.toContain(secret)
    expect(work).not.toHaveBeenCalled()
  })

  it('lets a payload at the limit through', async () => {
    const work = jest.fn(() => Promise.resolve())
    const probe = new Probe(support, work, false)
    const room = JobPayloadLimits[QueueNames.ANALYTICS] - JSON.stringify({ note: '' }).length
    const edge = { name: 'x', data: { note: 'x'.repeat(room) } } as unknown as Job<{
      correlationId?: string
    }>

    await expect(probe.process(edge)).resolves.toBeUndefined()
    expect(work).toHaveBeenCalledTimes(1)
  })
})
