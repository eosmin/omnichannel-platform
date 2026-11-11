import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import type { CancelShipmentJob } from '@platform/core/queues'
import { ShipmentCancellation, type VoidSettlement, VoidSettlements } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'

// The job that voids one guide at its carrier (TDD_17 §4.8). The shipment is CANCEL_PENDING when it is queued; the queue asks
// again, with the backoff of the job, while the carrier does not answer, and the last attempt leaves the guide CANCEL_FAILED
// (the team is told by the event of that move). A guide that is no longer CANCEL_PENDING is left alone, so a job that runs twice
// voids nothing twice.
@Injectable()
export class ShipmentCanceller {
  constructor(
    private readonly cancellation: ShipmentCancellation,
    private readonly registry: CarrierRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ShipmentCanceller.name)
  }

  // Resolves when the job is over; rejects when the queue has to try again
  async run(job: CancelShipmentJob, lastAttempt: boolean): Promise<VoidSettlement> {
    const settlement = await this.cancellation.settle(
      job.storeId,
      job.shipmentId,
      carrierId => this.registry.find(carrierId),
      {
        actor: { type: job.requestedBy === null ? 'system' : 'user', id: job.requestedBy },
        lastAttempt
      }
    )
    if (settlement === VoidSettlements.RETRY) {
      throw new Error('the carrier did not answer the void of a guide: asking again')
    }
    this.logger.info({ shipmentId: job.shipmentId, settlement }, 'a guide void was settled')
    return settlement
  }
}
