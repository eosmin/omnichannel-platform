import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { JobContext, PrismaService } from '@platform/core/database'
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

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

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
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
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
      const page = await this.prisma.client.store.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      // "Has stock or a ledger" is read in the context of each store: the rows of the stock are not visible from outside of one
      const stores: { id: string }[] = []
      for (const store of page) {
        const has = await this.jobContext.forStore(store.id, () =>
          this.prisma.client.store.findFirst({
            where: {
              id: store.id,
              OR: [{ inventoryLevels: { some: {} } }, { inventoryMovements: { some: {} } }]
            },
            select: { id: true }
          })
        )
        if (has !== null) stores.push(store)
      }
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
      if (page.length < pageSize) break
      cursor = page.at(-1)?.id
    }
    return queued
  }
}
