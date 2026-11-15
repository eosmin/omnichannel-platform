import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { CarrierConnectionStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { LockNames, Schedules } from '@platform/core/queues'
import { closeBenefitPeriods, readGuidePolicy } from '@platform/core/shipping'

import { LeaderLockService } from './leader-lock.service'

const LOCK_SECONDS = 600
const PAGE_SIZE = 200

// Daily, on one replica (TDD_17 §4.18): judges, once each, the periods of the refund benefit that ended since the last close, for
// every active connection whose policy has the benefit on. The unique row of a judged period makes a second run (or a second
// replica) a no-op, and a connection that fails is logged and left for tomorrow without stopping the others.
@Injectable()
export class BenefitCloseScheduler {
  constructor(
    private readonly locks: LeaderLockService,
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
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
  async closeAll(now: Date, options: { pageSize?: number } = {}): Promise<number> {
    const pageSize = options.pageSize ?? PAGE_SIZE
    let closed = 0
    let cursor: string | undefined
    for (;;) {
      const rows = await this.prisma.client.carrierGuidePolicy.findMany({
        where: {
          benefitEnabled: true,
          connection: { status: CarrierConnectionStatus.ACTIVE }
        },
        select: { connectionId: true, storeId: true },
        orderBy: { connectionId: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { connectionId: cursor }, skip: 1 })
      })
      for (const row of rows) {
        try {
          const policy = await readGuidePolicy(this.prisma.client, row.storeId, row.connectionId)
          if (policy === null) continue
          closed += (await closeBenefitPeriods(this.prisma, policy, now)).length
        } catch (error) {
          this.logger.error(
            { connectionId: row.connectionId, errorName: errorName(error) },
            'the benefit periods of a connection were not closed'
          )
        }
      }
      if (rows.length < pageSize) break
      cursor = rows.at(-1)?.connectionId
    }
    return closed
  }
}
