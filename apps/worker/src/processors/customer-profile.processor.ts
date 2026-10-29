import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { CustomerProfileFetch } from '@platform/core/domain'
import { type FetchCustomerProfileJob, JobNames, QueueNames } from '@platform/core/queues'

import { ProfileFetcher } from '../inbound/profile-fetcher.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

const jobSchema = z.object({
  storeId: z.uuid(),
  identityId: z.uuid(),
  connectionRowId: z.uuid()
})

// The worker half of the name and photo of a customer. It has a queue of its own so that a slow
// provider fills this one and never the queue where the messages of customers wait.
@Processor(QueueNames.CUSTOMER_PROFILES, { concurrency: CustomerProfileFetch.CONCURRENCY })
export class CustomerProfileProcessor extends BaseProcessor<FetchCustomerProfileJob> {
  constructor(
    support: ProcessorSupport,
    private readonly fetcher: ProfileFetcher
  ) {
    super(QueueNames.CUSTOMER_PROFILES, support)
  }

  protected async handle(job: Job<FetchCustomerProfileJob>): Promise<void> {
    // A name this queue does not know is no profile read
    if (job.name !== JobNames.FETCH_CUSTOMER_PROFILE) {
      throw new UnrecoverableError('the profile queue does not know this job')
    }
    const parsed = jobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the profile job does not fit its schema')
    await this.fetcher.fetch(parsed.data, isLastAttempt(job))
  }
}
