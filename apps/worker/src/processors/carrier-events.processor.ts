import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { exactly, JobNames, QueueNames } from '@platform/core/queues'
import { carrierEventSchema, type ProcessCarrierEventJob } from '@platform/plugins/runtime'

import { CarrierEventResolver } from '../carriers/carrier-event-resolver.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

// The keys of the job type, checked when it is compiled: zod drops what it is not told about. The store comes from the
// connection the api authenticated, and the job crossed Redis, so it is checked again before anything reads it.
const carrierEventJobSchema = exactly<ProcessCarrierEventJob>()(
  z.object({
    storeId: z.uuid(),
    connectionId: z.uuid(),
    event: carrierEventSchema,
    receivedAt: z.iso.datetime({ offset: true }),
    correlationId: z.string().optional()
  })
)

// The worker half of TDD_17 §4.9: the api verified the signature of the carrier and queued one job per event; this reads
// them. Today it resolves what each event means for its connection and records the codes nobody has mapped (§4.17); applying
// the status to a shipment (dedupe, order of arrival, the transition table, the order effects) is Step 4.8 PR C2c.
@Processor(QueueNames.WEBHOOKS, { concurrency: 10 })
export class CarrierEventsProcessor extends BaseProcessor<ProcessCarrierEventJob> {
  constructor(
    support: ProcessorSupport,
    private readonly resolver: CarrierEventResolver
  ) {
    super(QueueNames.WEBHOOKS, support)
  }

  protected async handle(job: Job<ProcessCarrierEventJob>): Promise<void> {
    // The queue is shared with the outbound webhooks of Phase 2 (Step 5.4): BullMQ gives a job to any worker of the queue, not by
    // name, so that step extends this processor with a dispatch by job name instead of adding a second one
    if (job.name !== JobNames.PROCESS_CARRIER_EVENT) {
      throw new UnrecoverableError('this queue has no processor for that job yet')
    }
    const parsed = carrierEventJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success)
      throw new UnrecoverableError('the carrier event job does not fit its schema')
    await this.resolver.resolve(parsed.data)
  }
}
