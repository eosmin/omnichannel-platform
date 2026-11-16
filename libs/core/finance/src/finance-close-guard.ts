import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'

import { FinanceSweepService, type SweepOptions } from './finance-sweep.service'

export interface CloseBlockers {
  // The open failures of the organization by reason (a mapping that is missing, a source that waits): each is a source with no entry
  failures: { reason: string; count: number }[]
  failureCount: number
  // Sources the sweep finds with no entry that a job would post now (an event that never reached the queue): they must post first
  pendingSources: number
  // The sweep stopped at its cap: there may be more than `pendingSources` says, so the close is refused too
  truncated: boolean
  // True when the month cannot be closed: a close that left a source out would be moved by a late posting (TDD_18 §5.1)
  blocked: boolean
}

// What stands between the books and a close of a period (TDD_18 §5.1, §6.1): any source that should have an entry and has none, or whose
// entry failed and nobody fixed it. The close of Step 4B.8 asks this before it locks a month; it reads, it never posts or queues. It is
// about the whole organization, not one period: a failure row carries no date of its source, so it is conservative (a later period's
// failure also stops an earlier close) until the row carries it (debt of the plan).
@Injectable()
export class FinanceCloseGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sweep: FinanceSweepService
  ) {}

  // `since` is the earliest date to look at: the sweep reaches back 120 days by itself, so the close of an older period names the
  // start of that period. The cost is one preview transaction per source the sweep finds with no entry, so a close that asks for
  // a long range of a large organization should run it as a job, not in the request.
  async check(
    organizationId: string,
    options: Pick<SweepOptions, 'since'> = {}
  ): Promise<CloseBlockers> {
    const grouped = await this.prisma.client.financePostingFailure.groupBy({
      by: ['reason'],
      where: { organizationId, resolvedAt: null },
      _count: { _all: true }
    })
    const failures = grouped
      .map(row => ({ reason: row.reason, count: row._count._all }))
      .sort((a, b) => a.reason.localeCompare(b.reason))
    const failureCount = failures.reduce((sum, row) => sum + row.count, 0)
    const swept = await this.sweep.sweep(organizationId, new Date(), options)
    const pendingSources = swept.toQueue.length
    return {
      failures,
      failureCount,
      pendingSources,
      truncated: swept.truncated,
      blocked: failureCount > 0 || pendingSources > 0 || swept.truncated
    }
  }
}
