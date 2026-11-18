import type { Job } from 'bullmq'

import { JobContextError, JobContextGoneError } from '@platform/core/database'
import { QueueNames } from '@platform/core/queues'

import { BaseProcessor } from './base.processor'
import type { ProcessorSupport } from './processor-support'

class Probe extends BaseProcessor<{ correlationId?: string }> {
  constructor(
    support: ProcessorSupport,
    private readonly work: () => Promise<void>
  ) {
    super(QueueNames.ANALYTICS, support)
  }

  protected handle(): Promise<void> {
    return this.work()
  }
}

describe('BaseProcessor and a subject that is gone', () => {
  const subjectGone = jest.fn()
  const support = {
    run: (_queue: string, job: Job, run: (job: Job) => Promise<void>) => run(job),
    subjectGone
  } as unknown as ProcessorSupport
  const job = { name: 'x', data: {} } as unknown as Job<{ correlationId?: string }>

  beforeEach(() => subjectGone.mockReset())

  it('ends as done, with a warning, a job whose store was deleted', async () => {
    const probe = new Probe(support, () => Promise.reject(new JobContextGoneError('gone')))
    await expect(probe.process(job)).resolves.toBeUndefined()
    expect(subjectGone).toHaveBeenCalledTimes(1)
  })

  it('lets any other error of the context fail the job, so that the queue retries it and its handler can close it', async () => {
    const probe = new Probe(support, () => Promise.reject(new JobContextError('hidden')))
    await expect(probe.process(job)).rejects.toBeInstanceOf(JobContextError)
    expect(subjectGone).not.toHaveBeenCalled()
  })
})
