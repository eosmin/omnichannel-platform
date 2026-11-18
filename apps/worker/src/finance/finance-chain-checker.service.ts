import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type ChainCheck, FinanceChainMonitor } from '@platform/core/finance-ledger'

// The weekly check of the hash chain of one organization's journal (TDD_18 §11). The monitor walks the journal, opens or clears the
// incident that stops the close, says it once when it opens and sets the gauge; here the weekly job logs the result. It never repairs anything: a break is for a person with the accountant.
@Injectable()
export class FinanceChainChecker {
  constructor(
    private readonly monitor: FinanceChainMonitor,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FinanceChainChecker.name)
  }

  // `requestedBy`: the person who asked for this check to close an incident, when it is not the weekly schedule
  async check(
    organizationId: string,
    now: Date = new Date(),
    requestedBy?: string
  ): Promise<ChainCheck> {
    const result = await this.monitor.check(organizationId, { resolve: true }, now)
    this.logger.info(
      {
        organizationId,
        ok: result.verification.ok,
        entriesChecked: result.verification.entriesChecked,
        incident: result.incident,
        requestedBy: requestedBy ?? null
      },
      requestedBy === undefined
        ? 'the weekly check of the hash chain ran'
        : 'the check of the hash chain a person asked for ran'
    )
    return result
  }
}
