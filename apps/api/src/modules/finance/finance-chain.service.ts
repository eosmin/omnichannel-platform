import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { FinanceConflicts, FinanceResourceTypes } from '@platform/core/domain'
import { resourceConflict } from '@platform/core/errors'
import {
  type ChainCheck,
  type ChainVerification,
  FinanceChainMonitor
} from '@platform/core/finance-ledger'

import type { Actor } from '../tenancy'

export type { ChainVerification } from '@platform/core/finance-ledger'

export interface ChainStatusView {
  open: {
    reason: string
    entryNumber: string | null
    entriesChecked: number
    detectedAt: string
    lastSeenAt: string
  } | null
}

// The check of the hash chain asked by a person (TDD_18 §11). The walk itself lives in `libs/core/finance` because the weekly job of the
// worker runs the same code; here is only what belongs to a request: one scan at a time and the audit row. A check that finds the chain
// altered opens the incident that stops the close, and one that passes closes it, exactly as the weekly one does.
@Injectable()
export class FinanceChainService {
  private readonly running = new Set<string>()

  constructor(
    private readonly monitor: FinanceChainMonitor,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService
  ) {}

  // The incident the weekly check left open for the organization, or none: it reads, it never checks (the check scans the journal)
  async status(organizationId: string): Promise<ChainStatusView> {
    const open = await this.prisma.client.financeChainIncident.findFirst({
      where: { organizationId, resolvedAt: null },
      select: {
        reason: true,
        entryNumber: true,
        entriesChecked: true,
        detectedAt: true,
        lastSeenAt: true
      }
    })
    return {
      open:
        open === null
          ? null
          : {
              reason: open.reason,
              entryNumber: open.entryNumber,
              entriesChecked: open.entriesChecked,
              detectedAt: open.detectedAt.toISOString(),
              lastSeenAt: open.lastSeenAt.toISOString()
            }
    }
  }

  // The answer is audited with the verdict and the count, never the rows. It scans the whole journal, so one organization runs one at a
  // time in this process: a second asked meanwhile is refused instead of piling scans on the database
  async verifyAudited(organizationId: string, actor: Actor): Promise<ChainVerification> {
    if (this.running.has(organizationId)) {
      throw resourceConflict('a check of the chain is running', {
        conflict: FinanceConflicts.CHAIN_CHECK_RUNNING
      })
    }
    this.running.add(organizationId)
    let check: ChainCheck
    try {
      check = await this.monitor.check(organizationId, new Date(), { resolve: false })
    } finally {
      this.running.delete(organizationId)
    }
    const result = check.verification
    this.audit.log({
      action: AuditAction.FINANCE_CHAIN_VERIFIED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.ENTRY,
      resourceId: organizationId,
      metadata: {
        ok: result.ok,
        entriesChecked: result.entriesChecked,
        reason: result.break?.reason ?? null,
        // What the check did to the incident that gates the close: opened, still_open, resolved or none
        incident: check.incident
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return result
  }
}
