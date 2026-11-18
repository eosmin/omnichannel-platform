import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { FinanceResourceTypes } from '@platform/core/domain'
import { type ChainCheck, FinanceChainMonitor } from '@platform/core/finance-ledger'

// The weekly check of the hash chain of one organization's journal (TDD_18 §11). The monitor walks the journal, opens or clears the
// incident that stops the close, says it once when it opens and sets the gauge; here the weekly job logs the result. It never repairs anything: a break is for a person with the accountant.
@Injectable()
export class FinanceChainChecker {
  constructor(
    private readonly monitor: FinanceChainMonitor,
    private readonly logger: PinoLogger,
    private readonly audit: AuditService
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
    // The check a person asked for is the one that may close an incident: it leaves a row with who asked and what it found (the
    // verdict and what happened to the incident), never the entries
    if (requestedBy !== undefined) {
      this.audit.log({
        action: AuditAction.FINANCE_CHAIN_RESOLVE_CHECKED,
        actor: { userId: requestedBy },
        organizationId,
        resourceType: FinanceResourceTypes.ENTRY,
        resourceId: organizationId,
        metadata: {
          ok: result.verification.ok,
          entriesChecked: result.verification.entriesChecked,
          reason: result.verification.break?.reason ?? null,
          incident: result.incident
        }
      })
    }
    return result
  }
}
