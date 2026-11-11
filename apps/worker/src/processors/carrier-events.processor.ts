import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { ShipmentEventSource } from '@platform/core/domain'
import { exactly, JobNames, QueueNames } from '@platform/core/queues'
import { carrierEventSchema, type ProcessCarrierEventJob } from '@platform/plugins/runtime'

import { CarrierEventApplier, CarrierEventHandled } from '../carriers/carrier-event-applier.service'

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
// them. Each one is resolved for its connection, finds its shipment and moves it through the status engine (dedupe, order of
// arrival, the transition table), or is kept in the history when nobody has said what its code means (§4.17).
@Processor(QueueNames.WEBHOOKS, { concurrency: 10 })
export class CarrierEventsProcessor extends BaseProcessor<ProcessCarrierEventJob> {
  constructor(
    support: ProcessorSupport,
    private readonly applier: CarrierEventApplier
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
    const outcome = await this.applier.apply(parsed.data, ShipmentEventSource.WEBHOOK)
    // Not an error of the job but a thing that may change in a moment: the carrier's own books lag behind its webhook, and a
    // webhook can outrun the guide being stored. BullMQ asks again; what never resolves ends in the dead letter queue, where a
    // person sees it, and not as a success that hides a lost event
    if (outcome === CarrierEventHandled.UNCONFIRMED || outcome === CarrierEventHandled.NOT_FOUND) {
      throw new Error(`the carrier event is not settled yet (${outcome})`)
    }
  }
}
