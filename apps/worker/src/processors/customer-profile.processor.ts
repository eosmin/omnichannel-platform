import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'

import { CustomerProfileFetch } from '@platform/core/domain'
import {
  type FetchCustomerProfileJob,
  fetchCustomerProfileJobSchema,
  JobNames,
  QueueNames
} from '@platform/core/queues'

import { ProfileFetcher } from '../inbound/profile-fetcher.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { JobRejectedError } from './job-rejected.error'
import { ProcessorSupport } from './processor-support'

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
    const parsed = fetchCustomerProfileJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new JobRejectedError('the profile job does not fit its schema')
    // A store deleted after the job was queued is a read with nothing left to do
    await this.skipIfGone(job, () => this.fetcher.fetch(parsed.data, isLastAttempt(job)))
  }
}
