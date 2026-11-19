import { Injectable } from '@nestjs/common'
import type { Gauge } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { inSavepoint, isUniqueViolation, PrismaService } from '@platform/core/database'
import { ChainIncidentChange, ChainProblem, FinanceReportLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

import { financeRefusal } from './ledger-errors'
import { type ChainEntry, verifyChain } from './ledger-hash'
import { dateToDay as isoDay } from './period-rules'

// Why a chain is not sound: the three the walk finds, and the two that only the places outside the chain can tell (TDD_18 §11)
export type ChainProblemCode = `${ChainProblem}`

const PROBLEM_OF: Record<ChainProblemCode, ChainProblem> = {
  [ChainProblem.NUMBER_GAP]: ChainProblem.NUMBER_GAP,
  [ChainProblem.PREV_HASH_MISMATCH]: ChainProblem.PREV_HASH_MISMATCH,
  [ChainProblem.HASH_MISMATCH]: ChainProblem.HASH_MISMATCH,
  [ChainProblem.HEAD_MISMATCH]: ChainProblem.HEAD_MISMATCH,
  [ChainProblem.FROZEN_HEAD_MISSING]: ChainProblem.FROZEN_HEAD_MISSING
}

export interface ChainVerification {
  ok: boolean
  entriesChecked: number
  // The last entry the chain holds, as the auditor can compare it with the last row of the CSV they hold
  headNumber: string | null
  headHash: string | null
  // The first break the walk found; the walk stops there
  break: { entryId: string; number: string; reason: ChainProblemCode } | null
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
// head each closed period froze must still be the hash of an entry. It reads; it changes nothing. The api (on demand, for the auditor) and
// the worker (weekly) run this same code.
@Injectable()
export class FinanceChainVerifier {
  constructor(private readonly prisma: PrismaService) {}

  // A posting that commits while the walk runs moves the head. After the walk the settings are read again: a head AHEAD of the last entry
  // walked means entries landed meanwhile, and the walk goes on from there (a few rounds), so a sound chain of a live ledger is never
  // reported as broken; a head that is equal in number and differs in hash, or still ahead after the rounds (a tail cut off behind the
  // application), is a break.
  async verify(organizationId: string): Promise<ChainVerification> {
    return this.walk(organizationId)
  }

  private async walk(organizationId: string): Promise<ChainVerification> {
    const db = this.prisma.client
    const readSettings = () =>
      db.financeSettings.findUnique({
        where: { organizationId },
        select: { nextEntryNumber: true, lastEntryHash: true }
      })
    if ((await readSettings()) === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)

    let from: { number: bigint; prevHash: string | null } = { number: 1n, prevHash: null }
    let entriesChecked = 0
    let head: { number: bigint; hash: string } | null = null
    let found: ChainVerification['break'] = null
    // Rounds of the walk that read nothing new while the head is still ahead: a head cut off behind the application stays ahead for ever
    let idle = 0
    while (found === null) {
      const before = entriesChecked
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
          // `head` stays the last entry of the last page that was whole; the count adds the sound entries of this one (the head is where the
          // walk could say the chain was sound to, the count is how many entries were read and found sound). What was read and found sound before the break counts as checked: a break in the first page of the walk is not zero entries
          entriesChecked += entries.filter(entry => entry.number < broken.number).length
          found = {
            entryId: broken.entryId,
            number: broken.number.toString(),
            reason: broken.reason
          }
          break
        }
        const last = entries.at(-1)
        if (last === undefined) break
        entriesChecked += entries.length
        head = { number: last.number, hash: last.hash }
        from = { number: last.number + 1n, prevHash: last.hash }
        if (page.length < FinanceReportLimits.CHAIN_PAGE_SIZE) break
      }

      if (found !== null) break
      // The head as it is now: consistent with the walk, ahead of it (postings landed during it: walk on), or a break
      const kept = await readSettings()
      const walked = (head?.number ?? 0n) + 1n
      if (kept === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
      if (kept.nextEntryNumber === walked && kept.lastEntryHash === (head?.hash ?? null)) break
      // Ahead of the walk and nothing new was read for a few rounds in a row, or behind it, or the same number with another hash: a break
      idle = entriesChecked > before ? 0 : idle + 1
      if (kept.nextEntryNumber <= walked || idle > HEAD_RETRIES) {
        found = {
          entryId: '',
          number: (head?.number ?? 0n).toString(),
          reason: ChainProblem.HEAD_MISMATCH
        }
      }
    }

    // Every period that was ever closed keeps the head it froze (a reopen keeps the record of the close, a trigger holds it), open again or
    // not: the entries up to that head are immutable, so a head that is no longer in the chain means entries were removed (HC-115)
    const closed = await db.fiscalPeriod.findMany({
      where: { organizationId, closingHash: { not: null } },
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
        reason: ChainProblem.FROZEN_HEAD_MISSING
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
}

export interface ChainCheck {
  verification: ChainVerification
  // What the check did to the incident of the organization: opened it, found it still open, closed it because the chain verifies again,
  // or nothing (a sound chain with no incident)
  incident: ChainIncidentChange
}

// What a check of the chain leaves behind (TDD_18 §11, Step 4B.8b-2): an alteration opens ONE incident per organization, which stops the
// close of a month (`FinanceCloseGuard`) and is told once (`FINANCE_CHAIN_BROKEN`); a check that passes closes it only when the caller may (the worker; see `check`). Nothing here touches
// the journal: an incident is the record that someone must look, never a repair. The check runs from the weekly job and from the
// auditor's request, so a chain restored (or a false alarm) is cleared by the next check of the weekly job that passes: the auditor's request reports it, and leaves the closing to the job.
@Injectable()
export class FinanceChainMonitor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verifier: FinanceChainVerifier,
    private readonly events: DomainEvents,
    // 1 while the chain is altered, 0 when it verifies: set by whoever ran the check (the weekly job or an auditor's request), a gauge of the
    // process that ran it (debt (j) of 4B.8b-2: a gauge computed from the table at scrape time is Step 7.3)
    @InjectMetric(MetricNames.FINANCE_CHAIN_BREAKS) private readonly breaks: Gauge<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FinanceChainMonitor.name)
  }

  // `resolve` says whether a passing check may close the open incident. Only the weekly job (the worker role) may: the database
  // takes UPDATE(resolved_at) away from the API role, so an application taken over cannot declare the books sound again. A check the
  // auditor asks for passes `resolve: false` and reports an open incident as STILL_OPEN until the job closes it
  // `options` is required on purpose: the privileged behaviour is never a default, so a caller in the API cannot reach it by omission
  async check(
    organizationId: string,
    options: { resolve: boolean },
    now: Date = new Date()
  ): Promise<ChainCheck> {
    const verification = await this.verifier.verify(organizationId)
    const incident = await this.record(organizationId, verification, now, options.resolve)
    this.breaks.set({ organization_id: organizationId }, verification.ok ? 0 : 1)
    return { verification, incident }
  }

  private async record(
    organizationId: string,
    verification: ChainVerification,
    now: Date,
    resolve: boolean
  ): Promise<ChainIncidentChange> {
    const broken = verification.break
    if (broken === null && !resolve) {
      const open = await this.prisma.client.financeChainIncident.count({
        where: { organizationId, resolvedAt: null }
      })
      return open > 0 ? ChainIncidentChange.STILL_OPEN : ChainIncidentChange.NONE
    }
    if (broken === null) {
      // A passing check closes whatever was open (a chain restored from a backup, or a head that moved during an earlier walk)
      const closed = await this.prisma.client.financeChainIncident.updateMany({
        where: { organizationId, resolvedAt: null },
        data: { resolvedAt: now }
      })
      if (closed.count > 0) {
        this.logger.info({ organizationId }, 'the hash chain of the books verifies again')
      }
      return closed.count > 0 ? ChainIncidentChange.RESOLVED : ChainIncidentChange.NONE
    }
    const details = {
      reason: broken.reason,
      entryNumber: broken.number,
      entriesChecked: verification.entriesChecked,
      lastSeenAt: now
    }
    // An open incident keeps what the first check found (its reason and entry): a later check only says it saw it again
    const seen = await this.prisma.client.financeChainIncident.updateMany({
      where: { organizationId, resolvedAt: null },
      data: { entriesChecked: details.entriesChecked, lastSeenAt: details.lastSeenAt }
    })
    if (seen.count > 0) return ChainIncidentChange.STILL_OPEN
    try {
      // The row and the event commit together: an incident nobody was told about cannot exist
      await inSavepoint(() =>
        this.prisma.transaction(async tx => {
          await tx.financeChainIncident.create({
            data: { organizationId, ...details, detectedAt: now }
          })
          this.events.publish(tx, Events.FINANCE_CHAIN_BROKEN, {
            organizationId,
            reason: PROBLEM_OF[broken.reason]
          })
        })
      )
    } catch (error) {
      // Another replica opened it between our update and our create: the partial unique index keeps it one
      if (isUniqueViolation(error)) return ChainIncidentChange.STILL_OPEN
      throw error
    }
    this.logger.error(
      { organizationId, reason: broken.reason, entryNumber: broken.number },
      'the hash chain of the books does not verify'
    )
    return ChainIncidentChange.OPENED
  }
}
