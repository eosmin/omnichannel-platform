import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  JobContext,
  JobContextGoneError,
  PrismaService,
  WorkerLists
} from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  CarrierPolling,
  carrierPollInterval,
  ShipmentKind
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  JobNames,
  LockNames,
  type PollShipmentStatusJob,
  pollShipmentStatusJobId,
  QueueNames,
  Schedules
} from '@platform/core/queues'
import { CarrierRegistry } from '@platform/plugins/runtime'

import { POLLED_STATUSES } from '../shipping/shipment-poller.service'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

const LOCK_SECONDS = 300
const MINUTE_MS = 60_000
const DAY_LENGTH = 10 // "2026-11-12" in an ISO date

// Every ten minutes, on one replica: one poll job for each connection that has packages on their way and whose interval has
// come. The bucket of the interval is in the job id, so two ticks (or two replicas) of one bucket are one job; a connection
// is asked on the first tick of its bucket. The ask itself is the heavy-processing job, so a slow carrier does not hold the lock.
@Injectable()
export class ShipmentPollScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING)
    private readonly heavyQueue: Queue<PollShipmentStatusJob>,
    private readonly prisma: PrismaService,
    private readonly registry: CarrierRegistry,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    private readonly lists: WorkerLists
  ) {
    this.logger.setContext(ShipmentPollScheduler.name)
  }

  @Cron(Schedules.POLL_SHIPMENT_STATUS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.POLL_SHIPMENT_STATUS, LOCK_SECONDS, async () => {
        const queued = await this.enqueueDue(new Date())
        this.logger.info({ queued }, 'shipment polls queued')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; the next tick tries again
      this.logger.error({ errorName: errorName(error) }, 'the shipment polls were not queued')
    }
  }

  async enqueueDue(now: Date): Promise<number> {
    // The connections with a package on its way, from the list of the database (read to its end); the settings of each one are then
    // read in the context of its store
    const groups = await this.lists.shipmentPollTargets({
      kind: ShipmentKind.OUTBOUND,
      statuses: POLLED_STATUSES,
      connectionStatus: CarrierConnectionStatus.ACTIVE
    })
    if (groups.length === 0) return 0
    const connections: {
      id: string
      carrierId: string
      pollIntervalMinutes: number | null
      webhookSecret: Uint8Array | null
    }[] = []
    const byStore = new Map<string, string[]>()
    for (const group of groups) {
      const ids = byStore.get(group.storeId) ?? []
      ids.push(group.connectionId)
      byStore.set(group.storeId, ids)
    }
    for (const [storeId, ids] of byStore) {
      try {
        connections.push(
          ...(await this.jobContext.forStore(storeId, () =>
            this.prisma.client.carrierConnection.findMany({
              where: { storeId, id: { in: ids } },
              select: { id: true, carrierId: true, pollIntervalMinutes: true, webhookSecret: true }
            })
          ))
        )
      } catch (error) {
        // A store deleted since the list was read has nothing left to poll
        if (!(error instanceof JobContextGoneError)) throw error
      }
    }
    const minute = Math.floor(now.getTime() / MINUTE_MS)
    // The one run of the day that also asks the packages older than two weeks
    const includeOld =
      now.getUTCHours() === CarrierPolling.OLD_RUN_HOUR_UTC &&
      now.getUTCMinutes() < CarrierPolling.TICK_MINUTES
    const groupOf = new Map(groups.map(group => [group.connectionId, group.storeId]))
    const day = now.toISOString().slice(0, DAY_LENGTH)
    const jobs: { name: string; data: PollShipmentStatusJob; opts: { jobId: string } }[] = []
    for (const connection of connections) {
      const plugin = this.registry.find(connection.carrierId)
      if (plugin === undefined || !plugin.capabilities.includes(CarrierCapability.FETCH_STATUS)) {
        continue
      }
      const interval = carrierPollInterval({
        configured: connection.pollIntervalMinutes,
        pushed:
          plugin.capabilities.includes(CarrierCapability.WEBHOOK_STATUS) &&
          connection.webhookSecret !== null
      })
      const storeId = groupOf.get(connection.id)
      if (storeId === undefined) continue
      // The daily run of the old packages is a job of its own (its own id), whatever the interval of the connection
      if (includeOld) {
        jobs.push({
          name: JobNames.POLL_SHIPMENT_STATUS,
          data: { storeId, connectionId: connection.id, includeOld: true },
          opts: { jobId: `${pollShipmentStatusJobId(connection.id, 0)}-old-${day}` }
        })
      }
      // The first tick of the bucket asks; the others of the same bucket have nothing to do
      if (minute % interval >= CarrierPolling.TICK_MINUTES) continue
      jobs.push({
        name: JobNames.POLL_SHIPMENT_STATUS,
        data: { storeId, connectionId: connection.id, includeOld: false },
        opts: { jobId: pollShipmentStatusJobId(connection.id, Math.floor(minute / interval)) }
      })
    }
    if (jobs.length > 0) await this.heavyQueue.addBulk(jobs)
    return jobs.length
  }
}
