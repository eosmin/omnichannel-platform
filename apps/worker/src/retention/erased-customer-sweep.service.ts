import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, RetentionResourceTypes } from '@platform/core/compliance'
import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import { DAY_MS } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

import { inEachStoreStrict } from '../schedulers/store-sweep'

import { ErasedCustomerData } from './erased-customer-data.service'
import { runAuditMetadata, runHasNews } from './run-audit'

// rls-context: the read of the pending customers runs inside JobContext.forStore of each store

// At most this many customers a store, a night: the rest waits for the next one
const CUSTOMERS_PER_STORE = 50

export interface ErasedSweepReport {
  customers: number
  cleared: number
  // Gone or not erased: nothing to do, which is no failure
  skipped: number
  failed: number
}

// The daily net under the job of the erasure: an erased customer whose data was not all cleared (the queue was down when it was erased, the
// bucket failed halfway, the worker died) is found here by its missing mark and finished. One that fails does not stop the others.
@Injectable()
export class ErasedCustomerSweep {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly data: ErasedCustomerData,
    private readonly logger: PinoLogger,
    private readonly audit: AuditService
  ) {
    this.logger.setContext(ErasedCustomerSweep.name)
  }

  // `until`: the moment (epoch ms) after which it starts no other customer, so a long backlog never outlasts the lock of the daily run
  async run(until: number = Number.POSITIVE_INFINITY): Promise<ErasedSweepReport> {
    const report: ErasedSweepReport = { customers: 0, cleared: 0, skipped: 0, failed: 0 }
    const recheckFrom = new Date(Date.now() - ComplianceConfig.ERASED_DATA_RECHECK_DAYS * DAY_MS)
    await inEachStoreStrict(this.prisma, async storeId => {
      const pending = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.customer.findMany({
          // Not cleared yet, or cleared lately: a write in flight at the erasure may have landed after the first run
          where: {
            storeId,
            erasedAt: { not: null },
            OR: [{ erasedDataPurgedAt: null }, { erasedDataPurgedAt: { gt: recheckFrom } }]
          },
          select: { id: true },
          // Never tried first, then the one tried longest ago
          orderBy: [{ erasedDataAttemptedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
          take: CUSTOMERS_PER_STORE
        })
      )
      for (const customer of pending) {
        if (Date.now() > until) return
        report.customers += 1
        try {
          const done = await this.data.clear(storeId, customer.id)
          if (done.cleared) report.cleared += 1
          else if (done.skipped) report.skipped += 1
          else report.failed += 1
        } catch (error) {
          // A store deleted while the sweep ran is not a failure of a customer
          if (error instanceof JobContextGoneError) {
            report.skipped += 1
            return
          }
          report.failed += 1
          this.logger.warn(
            { storeId, customerId: customer.id, errorName: errorName(error) },
            'the data of an erased customer could not be cleared'
          )
        }
      }
    })
    this.logger.info(report, 'the sweep of erased customers finished')
    // Counts only, never the customers: each one already has its own entry in its store when its data is cleared. No store: platform wide
    const metadata = runAuditMetadata(report, [], report.failed > 0 ? ['customers'] : [])
    if (runHasNews(metadata)) {
      this.audit.log({
        action: AuditAction.ERASED_CUSTOMER_SWEEP_RUN,
        actor: { system: true },
        resourceType: RetentionResourceTypes.PLATFORM,
        metadata
      })
    }
    return report
  }
}
