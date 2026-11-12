import { Injectable } from '@nestjs/common'

import type { SyncPickupJob } from '@platform/core/queues'
import { PickupSync, PickupSyncOutcomes } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

// The job that asks a carrier for a pickup, or tells it the count it holds is out of date (TDD_17 §4.10). It resolves when the job
// is over and rejects while the carrier does not answer, so the queue asks again with the backoff of the job; the last attempt
// ends the pickup (`PickupSync`).
@Injectable()
export class PickupSyncer {
  constructor(
    private readonly sync: PickupSync,
    private readonly registry: CarrierRegistry
  ) {}

  async run(job: SyncPickupJob, lastAttempt: boolean): Promise<void> {
    const outcome = await this.sync.run(
      job.storeId,
      job.pickupId,
      carrierId => this.registry.find(carrierId),
      lastAttempt
    )
    if (outcome === PickupSyncOutcomes.RETRY) {
      throw new Error('the carrier did not answer the pickup: asking again')
    }
  }
}
