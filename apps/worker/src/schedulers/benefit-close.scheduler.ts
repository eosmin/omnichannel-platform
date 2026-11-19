import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import {
  JobContext,
  JobContextGoneError,
  PrismaService,
  WorkerLists
} from '@platform/core/database'
import { CarrierConnectionStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'
import { closeBenefitPeriods, readGuidePolicy } from '@platform/core/shipping'

import { LeaderLockService } from './leader-lock.service'

// rls-context: the stores, organizations and connections are listed from global tables or from a list of the database (WorkerLists);
// every read or write of a table of a store runs inside JobContext.forStore / forOrganization

const LOCK_SECONDS = 600

// Daily, on one replica (TDD_17 §4.18): judges, once each, the periods of the refund benefit that ended since the last close, for
// every active connection whose policy has the benefit on. The unique row of a judged period makes a second run (or a second
// replica) a no-op, and a connection that fails is logged and left for tomorrow without stopping the others.
@Injectable()
export class BenefitCloseScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    private readonly lists: WorkerLists
  ) {
    this.logger.setContext(BenefitCloseScheduler.name)
  }

  @Cron(Schedules.CLOSE_BENEFIT_PERIODS)
  async run(): Promise<void> {
    try {
      await this.locks.withLock(LockNames.CLOSE_BENEFIT_PERIODS, LOCK_SECONDS, async () => {
        const closed = await this.closeAll(new Date())
        this.logger.info({ closed }, 'benefit periods closed')
      })
    } catch (error) {
      // A cron that throws must not take the worker down; tomorrow it tries again
      this.logger.error({ errorName: errorName(error) }, 'the benefit periods were not closed')
    }
  }

  // Returns how many periods were judged
  async closeAll(now: Date): Promise<number> {
    // The connections whose benefit is on come from the list of the database, read to its end (a list that stopped half way would
    // judge only some of them); each one is then judged in the context of its store
    const rows = await this.lists.benefitCloseTargets(CarrierConnectionStatus.ACTIVE)
    let closed = 0
    for (const row of rows) {
      try {
        closed += await this.jobContext.forStore(row.storeId, async () => {
          const policy = await readGuidePolicy(this.prisma.client, row.storeId, row.connectionId)
          if (policy === null) return 0
          return (await closeBenefitPeriods(this.prisma, policy, now)).length
        })
      } catch (error) {
        // A store deleted since the list was read has no benefit left to judge
        if (error instanceof JobContextGoneError) continue
        this.logger.error(
          { connectionId: row.connectionId, errorName: errorName(error) },
          'the benefit periods of a connection were not closed'
        )
      }
    }
    return closed
  }
}
