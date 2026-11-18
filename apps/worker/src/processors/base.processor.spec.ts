import { type Job, UnrecoverableError } from 'bullmq'

import {
  JobContextError,
  JobContextGoneError,
  JobContextMismatchError
} from '@platform/core/database'
import { QueueNames } from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
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
})
