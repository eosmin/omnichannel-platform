import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { pickupSyncJobOptions } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { JobNames, QueueNames, type SyncPickupJob, syncPickupJobId } from '@platform/core/queues'

// Hands the carrier's side of a pickup to the worker once the transaction that made or changed it has committed (TDD_17 §4.10): a
// carrier is never called inside a request. A queue that was down leaves the pickup as it is (PENDING, or with a count the carrier
// has not heard): the sweep of the scheduler asks again (Step 4.11, PR 2).
@Injectable()
export class PickupQueue {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<SyncPickupJob>
  ) {
    this.logger.setContext(PickupQueue.name)
  }

  async enqueue(
    storeId: string,
    pickupId: string,
    revision: number,
    requestedBy: string | null
  ): Promise<void> {
    // After the REAL commit (under RLS_CONTEXT the request is one transaction): the job reads the pickup that was just written. A queue
    // that is down is told in the log and never fails the request
    await this.prisma.afterCommitStep(this.prisma.client, async () => {
      try {
        await this.queue.add(
          JobNames.SYNC_PICKUP,
          { storeId, pickupId, requestedBy },
          pickupSyncJobOptions(syncPickupJobId(pickupId, revision))
        )
      } catch (error) {
        this.logger.error(
          { pickupId, errorName: errorName(error) },
          'a pickup sync could not be queued'
        )
      }
    })
  }
}
