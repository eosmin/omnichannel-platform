import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { InventoryLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  JobNames,
  LockNames,
  QueueNames,
  reconcileInventoryJobId,
  type ReconcileInventoryJob,
  Schedules
} from '@platform/core/queues'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 600
const DAY_LENGTH = 10 // "2026-11-12" in an ISO date

// Daily at 04:00 UTC, on one replica (TDD_16 §4.8): one reconciliation job for each store that has stock or a ledger.
// The check itself is the heavy-processing job, so a slow store does not hold the lock of the schedule.
@Injectable()
export class InventoryReconcileScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<ReconcileInventoryJob>,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InventoryReconcileScheduler.name)
  }

  @Cron(Schedules.RECONCILE_INVENTORY)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.RECONCILE_INVENTORY, LOCK_SECONDS, async () => {
        const queued = await this.enqueueAll(new Date())
        this.logger.info({ queued }, 'inventory reconciliation queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error(
        { errorName: errorName(error) },
        'the inventory reconciliation was not queued'
      )
    }
  }

  // The job id carries the store and the UTC day: the same day asked twice is one job, whatever the replica
  async enqueueAll(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    const pageSize = options.pageSize ?? InventoryLimits.RECONCILE_STORES_PAGE_SIZE
    const day = now.toISOString().slice(0, DAY_LENGTH)
    let queued = 0
    let cursor: string | undefined
    for (;;) {
      const stores = await this.prisma.client.store.findMany({
        where: {
          OR: [{ inventoryLevels: { some: {} } }, { inventoryMovements: { some: {} } }]
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      if (stores.length > 0) {
        await this.heavyQueue.addBulk(
          stores.map(store => ({
            name: JobNames.RECONCILE_INVENTORY,
            data: { storeId: store.id },
            opts: { jobId: reconcileInventoryJobId(store.id, day) }
          }))
        )
        queued += stores.length
      }
      if (stores.length < pageSize) break
      cursor = stores.at(-1)?.id
    }
    return queued
  }
}
