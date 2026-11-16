import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  FinanceConflicts,
  FinanceReportLimits,
  FinanceResourceTypes,
  PeriodStatus
} from '@platform/core/domain'
import { ErrorCodes, resourceConflict } from '@platform/core/errors'
import { type ChainBreak, type ChainEntry, verifyChain } from '@platform/core/finance-hash'
import { financeRefusal } from '@platform/core/finance-ledger'

import type { Actor } from '../tenancy'

import { isoDay } from './finance.views'

// Why a chain is not sound: the three the walk finds, and the two that only the places outside the chain can tell (TDD_18 §11)
export type ChainProblem = ChainBreak['reason'] | 'head_mismatch' | 'frozen_head_missing'

export interface ChainVerification {
  ok: boolean
  entriesChecked: number
  // The last entry the chain holds, as the auditor can compare it with the last row of the CSV they hold
  headNumber: string | null
  headHash: string | null
  // The first break the walk found; the walk stops there
  break: { entryId: string; number: string; reason: ChainProblem } | null
  // The head each closed period froze when it closed, and whether an entry of the chain still carries that hash
  frozenHeads: { periodId: string; year: number; month: number; present: boolean }[]
}

// Walks of one check that find the head moved before the last one stops asking
const HEAD_RETRIES = 3

const ENTRY_FIELDS = {
  id: true,
  number: true,
  entryDate: true,
  periodId: true,
  totalCents: true,
  currency: true,
  type: true,
  sourceType: true,
  sourceId: true,
  sourceDate: true,
  reversesEntryId: true,
  idempotencyKey: true,
  memo: true,
  origin: true,
  createdBy: true,
  prevHash: true,
  hash: true,
  lines: {
    select: {
      lineNo: true,
      accountId: true,
      debitCents: true,
      creditCents: true,
      storeId: true,
      partyType: true,
      partyId: true,
      taxRateId: true,
      memo: true
    },
    orderBy: { lineNo: 'asc' as const }
  }
} as const

// The check of the hash chain of the journal (TDD_18 §11): every hash is recomputed from the row as it is now and every prevHash is the
// hash of the entry before. Beyond the walk, the head the settings keep must be the last entry (a truncated tail is caught here) and the
// head each closed period froze must still be the hash of an entry. It reads; it changes nothing.
@Injectable()
export class FinanceChainService {
  private readonly running = new Set<string>()

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  // A posting that commits while the walk runs moves the head: the settings are read again after the walk, and a walk over a head that
  // moved is made again (a few times), so a sound chain of a live ledger is never reported as broken
  async verify(organizationId: string): Promise<ChainVerification> {
    for (let attempt = 1; ; attempt += 1) {
      // The last walk takes the head as it finds it
      const result = await this.walk(organizationId, attempt >= HEAD_RETRIES)
      if (result !== 'moved') return result
    }
  }

  private async walk(organizationId: string, final = false): Promise<ChainVerification | 'moved'> {
    const db = this.prisma.client
    const settings = await db.financeSettings.findUnique({
      where: { organizationId },
      select: { nextEntryNumber: true, lastEntryHash: true }
    })
    if (settings === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)

    let from: { number: bigint; prevHash: string | null } = { number: 1n, prevHash: null }
    let entriesChecked = 0
    let head: { number: bigint; hash: string } | null = null
    let found: ChainVerification['break'] = null
    for (;;) {
      const page = await db.journalEntry.findMany({
        where: { organizationId, number: { gte: from.number } },
        select: ENTRY_FIELDS,
        orderBy: { number: 'asc' },
        take: FinanceReportLimits.CHAIN_PAGE_SIZE
      })
      if (page.length === 0) break
      const entries: ChainEntry[] = page.map(row => ({
        id: row.id,
        number: row.number,
        entryDate: isoDay(row.entryDate),
        periodId: row.periodId,
        totalCents: row.totalCents,
        currency: row.currency,
        type: row.type,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceDate: row.sourceDate === null ? null : isoDay(row.sourceDate),
        reversesEntryId: row.reversesEntryId,
        idempotencyKey: row.idempotencyKey,
        memo: row.memo,
        origin: row.origin,
        createdBy: row.createdBy,
        prevHash: row.prevHash,
        hash: row.hash,
        lines: row.lines
      }))
      const broken = verifyChain(entries, from)
      if (broken !== null) {
        found = { entryId: broken.entryId, number: broken.number.toString(), reason: broken.reason }
        break
      }
      const last = entries.at(-1)
      if (last === undefined) break
      entriesChecked += entries.length
      head = { number: last.number, hash: last.hash }
      from = { number: last.number + 1n, prevHash: last.hash }
      if (page.length < FinanceReportLimits.CHAIN_PAGE_SIZE) break
    }

    const again = await db.financeSettings.findUnique({
      where: { organizationId },
      select: { nextEntryNumber: true, lastEntryHash: true }
    })
    if (
      !final &&
      (again?.nextEntryNumber !== settings.nextEntryNumber ||
        again.lastEntryHash !== settings.lastEntryHash)
    ) {
      return 'moved'
    }
    // The settings hold the number the next entry takes and the hash of the last one: a tail cut off behind the application leaves them ahead
    if (found === null) {
      const expectedNext = (head?.number ?? 0n) + 1n
      // The head as it is after the walk: a posting during the last walk is not a tampering
      const kept = again ?? settings
      if (kept.nextEntryNumber !== expectedNext || kept.lastEntryHash !== (head?.hash ?? null)) {
        found = {
          entryId: '',
          number: (head?.number ?? 0n).toString(),
          reason: 'head_mismatch'
        }
      }
    }

    const closed = await db.fiscalPeriod.findMany({
      where: { organizationId, status: PeriodStatus.CLOSED, closingHash: { not: null } },
      select: { id: true, year: true, month: true, closingHash: true },
      orderBy: [{ year: 'asc' }, { month: 'asc' }]
    })
    const known = new Set(
      (
        await db.journalEntry.findMany({
          where: {
            organizationId,
            hash: {
              in: closed.flatMap(period =>
                period.closingHash === null ? [] : [period.closingHash]
              )
            }
          },
          select: { hash: true }
        })
      ).map(entry => entry.hash)
    )
    const frozenHeads: ChainVerification['frozenHeads'] = closed.map(period => ({
      periodId: period.id,
      year: period.year,
      month: period.month,
      present: period.closingHash !== null && known.has(period.closingHash)
    }))
    if (found === null && frozenHeads.some(frozen => !frozen.present)) {
      found = {
        entryId: '',
        number: (head?.number ?? 0n).toString(),
        reason: 'frozen_head_missing'
      }
    }

    return {
      ok: found === null,
      entriesChecked,
      headNumber: head === null ? null : head.number.toString(),
      headHash: head === null ? null : head.hash,
      break: found,
      frozenHeads
    }
  }

  // The same check, asked by a person: the answer is audited with the verdict and the count, never the rows. It scans the whole journal, so
  // one organization runs one at a time: a second asked meanwhile is refused instead of piling scans on the database
  async verifyAudited(organizationId: string, actor: Actor): Promise<ChainVerification> {
    if (this.running.has(organizationId)) {
      throw resourceConflict('a check of the chain is running', {
        conflict: FinanceConflicts.CHAIN_CHECK_RUNNING
      })
    }
    this.running.add(organizationId)
    let result: ChainVerification
    try {
      result = await this.verify(organizationId)
    } finally {
      this.running.delete(organizationId)
    }
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
        reason: result.break?.reason ?? null
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return result
  }
}
