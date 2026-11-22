import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, RetentionResourceTypes } from '@platform/core/compliance'
import {
  JobContext,
  JobContextError,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { DAY_MS } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

import { allStoreIds } from '../schedulers/store-sweep'

import { ErasedCustomerData } from './erased-customer-data.service'
import { runAuditMetadata, runHasNews } from './run-audit'

// rls-context: the read of the pending customers runs inside JobContext.forStore of each store

// At most this many customers a store, a night: the rest waits for the next one
const CUSTOMERS_PER_STORE = 50
// The most one customer may take of the night's budget: a thread so big that it does not fit is continued the next night, and the customers
// after it (and the stores after its store) are not starved by it
const CUSTOMER_BUDGET_MS = 5 * 60 * 1000

// The names an entry of the sweep gives to what stopped or failed (the keys of the report that count what was done are its own)
const SweepAuditNames = { CUSTOMERS: 'customers', STORES: 'stores' } as const
// What the report counts as looked at, not done: a run that only looked leaves no entry
const SWEEP_NOT_NEWS = ['customers', 'skipped', 'unfinished'] as const

export interface ErasedSweepReport {
  customers: number
  cleared: number
  // Gone or not erased: nothing to do, which is no failure
  skipped: number
  // Stopped with rows left (the time budget of the run): no failure, the next night takes the rest
  unfinished: number
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
    const report: ErasedSweepReport = {
      customers: 0,
      cleared: 0,
      skipped: 0,
      unfinished: 0,
      failed: 0
    }
    const more: string[] = []
    const failedRun: string[] = []
    const recheckFrom = new Date(Date.now() - ComplianceConfig.ERASED_DATA_RECHECK_DAYS * DAY_MS)
    let stores: { failed: number; total: number }
    try {
      stores = await this.sweepStores(report, recheckFrom, until, more)
    } catch (error) {
      // The list of the stores itself failed: the night's sweep is said to have failed, not only logged
      failedRun.push(SweepAuditNames.STORES)
      this.audit.log(this.entryOf(report, more, failedRun))
      throw error
    }
    if (stores.failed > 0) {
      // The stores that could not be entered did not stop the others: what was cleared is said, the failure is too, and the run fails loudly
      failedRun.push(SweepAuditNames.STORES)
      this.audit.log(this.entryOf(report, more, failedRun))
      throw new JobContextError(
        `the sweep of erased customers could not enter ${stores.failed} of ${stores.total} stores`
      )
    }
    this.logger.info(report, 'the sweep of erased customers finished')
    const entry = this.entryOf(report, more, failedRun)
    if (runHasNews(entry.metadata, SWEEP_NOT_NEWS)) this.audit.log(entry)
    return report
  }

  // Counts only, never the customers: each one already has its own entry in its store when its data is cleared. No store: platform wide
  private entryOf(report: ErasedSweepReport, more: string[], failedRun: string[]) {
    const failed = report.failed > 0 ? [SweepAuditNames.CUSTOMERS, ...failedRun] : failedRun
    return {
      action: AuditAction.ERASED_CUSTOMER_SWEEP_RUN,
      actor: { system: true } as const,
      resourceType: RetentionResourceTypes.PLATFORM,
      metadata: runAuditMetadata(report, more, failed)
    }
  }

  private async sweepStores(
    report: ErasedSweepReport,
    recheckFrom: Date,
    until: number,
    more: string[]
  ): Promise<{ failed: number; total: number }> {
    const storeIds = await allStoreIds(this.prisma)
    let failed = 0
    // Store by store, and a store that fails does not stop the rest of the night: the strict loop of the other sweeps exists because they decide
    // by what they do NOT find; this one acts only on the customers that carry `erased_at`, so a store it cannot read deletes nothing and waits
    for (const storeId of storeIds) {
      // The time budget is over: the stores left wait for tomorrow
      if (Date.now() > until) {
        if (!more.includes(SweepAuditNames.STORES)) more.push(SweepAuditNames.STORES)
        break
      }
      try {
        await this.sweepStore(storeId, report, recheckFrom, until, more)
      } catch (error) {
        // A store deleted between the list and its turn has nothing left to sweep
        if (error instanceof JobContextGoneError) continue
        failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'the sweep of erased customers could not enter a store'
        )
      }
    }
    return { failed, total: storeIds.length }
  }

  private async sweepStore(
    storeId: string,
    report: ErasedSweepReport,
    recheckFrom: Date,
    until: number,
    more: string[]
  ): Promise<void> {
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
    // A full page: a store may hold more, tomorrow takes them
    if (pending.length === CUSTOMERS_PER_STORE && !more.includes(SweepAuditNames.CUSTOMERS)) {
      more.push(SweepAuditNames.CUSTOMERS)
    }
    for (const customer of pending) {
      if (Date.now() > until) {
        if (!more.includes(SweepAuditNames.CUSTOMERS)) more.push(SweepAuditNames.CUSTOMERS)
        return
      }
      report.customers += 1
      try {
        const done = await this.data.clear(
          storeId,
          customer.id,
          Math.min(until, Date.now() + CUSTOMER_BUDGET_MS)
        )
        if (done.cleared) report.cleared += 1
        else if (done.skipped) report.skipped += 1
        else if (done.unfinished) {
          report.unfinished += 1
          if (!more.includes(SweepAuditNames.CUSTOMERS)) more.push(SweepAuditNames.CUSTOMERS)
        } else report.failed += 1
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
  }
}
