import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Gauge } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { financePostingJobOptions } from '@platform/core/domain'
import { FinanceSweepService } from '@platform/core/finance-ledger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  JobNames,
  type PostFinanceEventJob,
  postFinanceEventJobId,
  QueueNames
} from '@platform/core/queues'

export interface FinanceReconcileReport {
  examined: number
  queued: number
  openFailures: number
  unposted: number
  balanceMismatches: number
  truncated: boolean
}

// The daily check of the books of one organization (TDD_18 §6.1, §11). It finds the sources that should have an entry and have none and
// ASKS the posting job for each one: it never posts itself and never writes outside the idempotency of that job (the job reads the rows and
// posts under the key of its event, so a source found twice is one entry). It also compares the balances with the lines and counts a
// difference, which only a person fixes. A source it cannot check is logged and the rest goes on.
@Injectable()
export class FinanceReconciler {
  constructor(
    private readonly sweep: FinanceSweepService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue<PostFinanceEventJob>,
    @InjectMetric(MetricNames.FINANCE_UNPOSTED_SOURCES) private readonly unposted: Gauge<string>,
    @InjectMetric(MetricNames.FINANCE_BALANCE_MISMATCHES)
    private readonly mismatches: Gauge<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FinanceReconciler.name)
  }

  async reconcile(organizationId: string, now: Date = new Date()): Promise<FinanceReconcileReport> {
    const swept = await this.sweep.sweep(organizationId, now)
    const day = now.toISOString().slice(0, 10)
    if (swept.toQueue.length > 0) {
      await this.queue.addBulk(
        swept.toQueue.map(job => ({
          name: JobNames.POST_FINANCE_EVENT,
          data: job,
          // One job for each source and event per day: a retried check, or a backlog that drains over several nights, never piles up copies
          opts: {
            ...financePostingJobOptions(),
            jobId: postFinanceEventJobId(job.kind, job.sourceId, day)
          }
        }))
      )
    }
    // What the sweep queued plus what is still open, each source once: the number a person looking at the dashboard must see go to zero
    this.unposted.set({ organization_id: organizationId }, swept.unposted)
    if (swept.truncated) {
      // The run stopped at a cap: the number above is a floor, and the rest is for tomorrow
      this.logger.warn({ organizationId }, 'the check of the books stopped at its cap')
    }
    const balanceMismatches = await this.sweep.balanceMismatches(organizationId)
    // How many there are now, so that it goes back to zero when someone fixes them
    this.mismatches.set({ organization_id: organizationId }, balanceMismatches)
    if (balanceMismatches > 0) {
      // Never fixed from here: the journal is the truth and a correction is a person's decision
      this.logger.error(
        { organizationId, balanceMismatches },
        'the balances of the books disagree with their lines'
      )
    }
    this.logger.info(
      {
        organizationId,
        examined: swept.examined,
        queued: swept.toQueue.length,
        openFailures: swept.openFailures,
        truncated: swept.truncated
      },
      'the books were checked'
    )
    return {
      examined: swept.examined,
      queued: swept.toQueue.length,
      openFailures: swept.openFailures,
      unposted: swept.unposted,
      balanceMismatches,
      truncated: swept.truncated
    }
  }
}
