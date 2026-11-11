import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { ShipmentCancelLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  type CancelShipmentJob,
  cancelShipmentJobId,
  JobNames,
  QueueNames
} from '@platform/core/queues'
import { ShipmentCancellation, type VoidJob } from '@platform/core/shipping'

// Hands the voids that a transaction started to the worker (TDD_17 §4.8), once that transaction has committed: the carrier is
// never called inside a request, and a guide that nobody queued stays CANCEL_PENDING, where a second request asks again after
// fifteen minutes (the sweep that does not wait for a person is Step 7.4).
@Injectable()
export class ShipmentVoidQueue {
  constructor(
    private readonly cancellation: ShipmentCancellation,
    private readonly logger: PinoLogger,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<CancelShipmentJob>
  ) {
    this.logger.setContext(ShipmentVoidQueue.name)
  }

  async enqueue(
    storeId: string,
    jobs: readonly VoidJob[],
    requestedBy: string | null
  ): Promise<void> {
    for (const job of jobs) {
      try {
        await this.queue.add(
          JobNames.CANCEL_SHIPMENT,
          { storeId, shipmentId: job.shipmentId, requestedBy },
          {
            jobId: cancelShipmentJobId(job.shipmentId, job.requestedAt.getTime()),
            attempts: ShipmentCancelLimits.JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: ShipmentCancelLimits.BACKOFF_BASE_MS }
          }
        )
      } catch (error) {
        // The shipment is committed as CANCEL_PENDING and nothing will ask the carrier: it is left CANCEL_FAILED, which tells the
        // team, and the request does not fail for a queue that was down
        this.logger.error(
          { shipmentId: job.shipmentId, errorName: errorName(error) },
          'a void of a guide could not be queued'
        )
        await this.cancellation
          .markNotQueued(storeId, job.shipmentId, { type: 'user', id: requestedBy })
          .catch(() => undefined)
      }
    }
  }
}
