import { Injectable } from '@nestjs/common'

import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  EntryOrigin,
  FinanceConflicts,
  FinanceCurrency,
  FinanceIdempotencyKey,
  FinanceLimits,
  JournalEntryType,
  PartyType,
  PeriodStatus,
  ReconciliationMatchStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { type DraftLine, reverseLines, validateDraftEntry } from './entry-rules'
import { entryProblemsError, financeRefusal, triggerRefusal } from './ledger-errors'
import { hashEntry } from './ledger-hash'
import type { PostedEntry, PostEntryInput, ReverseEntryInput } from './ledger.types'
import {
  dateToDay,
  dayToDate,
  entryDateProblem,
  type LedgerCalendar,
  periodOfDate,
  reversalDate
} from './period-rules'

// A post takes the lock of the settings row of its organization, and a close and other posts can queue behind it: more room than
// the default of Prisma. When the caller passes (or the request holds) a transaction, the lock lasts until that one commits, so a
// caller keeps the work around a post short and takes no other lock before it. The balance of an entry is checked by a trigger at
// COMMIT: with a transaction of the caller's that commit is theirs, and the service has refused an entry that does not balance before it
// gets there, so the typed answer of the trigger is the net for the transaction the service opens itself
const POST_TRANSACTION = { maxWait: 10_000, timeout: 20_000 }

interface LockedSettings {
  nextNumber: bigint
  lastHash: string | null
  calendar: LedgerCalendar
}

const isoDay = dateToDay
const dayDate = dayToDate

// A memo is what a person typed with the edges trimmed, and nothing at all when it is blank: so what is stored, what is
// hashed and what a retry sends are the same text
const normalizedMemo = (memo: string | null | undefined): string | null => {
  const trimmed = memo?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

interface StoredLine {
  accountId: string
  debitCents: number
  creditCents: number
  storeId: string | null
  partyType: string | null
  partyId: string | null
  taxRateId: string | null
  memo: string | null
  lineNo: number
}

const lineOf = (line: DraftLine, index: number): StoredLine => ({
  accountId: line.accountId,
  debitCents: line.debitCents,
  creditCents: line.creditCents,
  storeId: line.storeId ?? null,
  partyType: line.partyType ?? null,
  partyId: line.partyId ?? null,
  taxRateId: line.taxRateId ?? null,
  memo: normalizedMemo(line.memo),
  lineNo: index + 1
})

// The ONLY writer of the journal (TDD_18 §9.2: a lint rule keeps everything else out, and the database refuses the rest).
// One post is one transaction: the settings row is locked (the posts of an organization take turns, which is what makes
// the number gapless and the chain one line), the entry is checked against the rules and the books, and the entry and its
// lines are written with the next number and the hash that follows the head. The counter, the head and the balances by
// period move by trigger in the same transaction, so nothing here can leave them behind the journal. A caller that has a
// transaction of its own passes it, and the entry commits or fails with it.
@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents
  ) {}

  // Posts one entry. The same key twice writes it once and answers the first (`replayed`); the same key with another
  // content is a mistake and is refused, never an overwrite (TDD_18 §4.1 rule 4).
  async post(input: PostEntryInput, tx?: PrismaTransaction): Promise<PostedEntry> {
    // A reversal names the entry it reverses, which only `reverse` can say, and its key is `reverse`'s alone
    if (
      input.type === JournalEntryType.REVERSAL ||
      input.idempotencyKey.startsWith(FinanceIdempotencyKey.REVERSAL(''))
    ) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'a reversal is written by reverse(), not posted',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    this.check(input)
    return this.run(tx, async inner => {
      const settings = await this.lockSettings(inner, input.organizationId)
      return this.write(inner, input, settings, null)
    })
  }

  // The reversing entry of an entry (TDD_18 §2.5): the same lines with their sides swapped, dated like the original or in
  // the open period when the original's is closed. The original is never touched, and an entry is reversed at most once.
  async reverse(input: ReverseEntryInput, tx?: PrismaTransaction): Promise<PostedEntry> {
    return this.run(tx, async inner => {
      const settings = await this.lockSettings(inner, input.organizationId)
      const original = await inner.journalEntry.findFirst({
        where: { id: input.entryId, organizationId: input.organizationId },
        include: { lines: { orderBy: { lineNo: 'asc' } } }
      })
      if (original === null) throw resourceNotFound('journal entry')
      // A reversal is not reversed: it could put the original's effect back on an account that is off since
      if ((original.type as JournalEntryType) === JournalEntryType.REVERSAL) {
        throw resourceConflict('a reversal is not reversed', {
          conflict: FinanceConflicts.REVERSAL_NOT_REVERSIBLE
        })
      }
      // A retry after a lost answer finds its own reversal and answers it
      const mine = await inner.journalEntry.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: FinanceIdempotencyKey.REVERSAL(original.id)
          }
        },
        select: {
          id: true,
          reversesEntryId: true,
          number: true,
          entryDate: true,
          periodId: true,
          totalCents: true,
          hash: true
        }
      })
      if (mine !== null) {
        // The key is only ever written by reverse(): anything else under it is a mistake, never a replay
        if (mine.reversesEntryId !== original.id) {
          throw resourceConflict('the reversal key belongs to another entry', {
            entryId: original.id
          })
        }
        return {
          id: mine.id,
          number: mine.number,
          entryDate: isoDay(mine.entryDate),
          periodId: mine.periodId,
          type: JournalEntryType.REVERSAL,
          totalCents: mine.totalCents,
          hash: mine.hash,
          replayed: true
        }
      }
      const reversed = await inner.journalEntry.findFirst({
        where: { organizationId: input.organizationId, reversesEntryId: original.id },
        select: { id: true }
      })
      if (reversed !== null) {
        throw financeRefusal(ErrorCodes.FINANCE_ENTRY_ALREADY_REVERSED, { entryId: original.id })
      }
      // A line that a bank statement was reconciled with is evidence that the money moved: the match is taken back first (the database
      // holds the same rule under a lock, for a confirmation and a reversal that run at the same moment)
      const reconciled = await inner.reconciliationMatch.findFirst({
        where: {
          organizationId: input.organizationId,
          status: ReconciliationMatchStatus.CONFIRMED,
          journalLine: { entryId: original.id }
        },
        select: { id: true }
      })
      if (reconciled !== null) {
        throw financeRefusal(ErrorCodes.FINANCE_ENTRY_RECONCILED, { entryId: original.id })
      }
      const entryDate = reversalDate(isoDay(original.entryDate), input.entryDate, settings.calendar)
      // Never before the entry it reverses, and always with a reason
      if (entryDate < isoDay(original.entryDate) || input.memo.trim().length === 0) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_INVALID_INPUT,
          'a reversal is not dated before its entry and says why',
          HttpStatusCodes.BAD_REQUEST
        )
      }
      const draft: PostEntryInput = {
        organizationId: input.organizationId,
        entryDate,
        type: JournalEntryType.REVERSAL,
        sourceType: original.sourceType as PostEntryInput['sourceType'],
        sourceId: original.sourceId,
        sourceDate: original.sourceDate === null ? null : isoDay(original.sourceDate),
        idempotencyKey: FinanceIdempotencyKey.REVERSAL(original.id),
        memo: input.memo,
        origin: EntryOrigin.USER,
        createdBy: input.createdBy,
        lines: reverseLines(
          original.lines.map(line => ({
            accountId: line.accountId,
            debitCents: line.debitCents,
            creditCents: line.creditCents,
            storeId: line.storeId,
            partyType: line.partyType as PartyType | null,
            partyId: line.partyId,
            taxRateId: line.taxRateId,
            memo: line.memo
          }))
        )
      }
      this.check(draft)
      return this.write(inner, draft, settings, original.id)
    })
  }

  private async run<T>(
    tx: PrismaTransaction | undefined,
    work: (inner: PrismaTransaction) => Promise<T>
  ): Promise<T> {
    try {
      return await (tx === undefined ? this.prisma.transaction(work, POST_TRANSACTION) : work(tx))
    } catch (error) {
      // A race the service could not see (an account switched off, a period closed a moment ago) is refused by a trigger:
      // the person gets the typed answer
      throw triggerRefusal(error) ?? error
    }
  }

  private check(input: PostEntryInput): void {
    const problems = validateDraftEntry({ ...input, currency: FinanceCurrency })
    if (problems.length > 0) throw entryProblemsError(problems)
    // The author and the origin agree: a user's entry names the user, the system's names nobody (the hash covers both)
    if ((input.origin === EntryOrigin.USER) !== (input.createdBy !== null)) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'an entry of a user names the user, an entry of the system names nobody',
        HttpStatusCodes.BAD_REQUEST
      )
    }
  }

  // The settings row of the organization, locked until the transaction ends. The next number and the head of the chain are
  // read from it, under the lock, so they are the ones the entry must follow.
  private async lockSettings(
    tx: PrismaTransaction,
    organizationId: string
  ): Promise<LockedSettings> {
    const [row] = await tx.$queryRaw<
      {
        next: bigint
        hash: string | null
        start: Date
        locked: Date | null
      }[]
    >`SELECT next_entry_number AS next, last_entry_hash AS hash, accounting_start_date AS start, locked_through AS locked
      FROM finance_settings WHERE organization_id = ${organizationId} FOR UPDATE`
    if (row === undefined) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
    return {
      nextNumber: row.next,
      lastHash: row.hash,
      calendar: {
        accountingStartDate: isoDay(row.start),
        lockedThrough: row.locked === null ? null : isoDay(row.locked)
      }
    }
  }

  private async write(
    tx: PrismaTransaction,
    input: PostEntryInput,
    settings: LockedSettings,
    reversesEntryId: string | null
  ): Promise<PostedEntry> {
    const { organizationId } = input
    const lines = input.lines.map(lineOf)
    const memo = normalizedMemo(input.memo)

    // The same key is the same request: found, not written again. It is read under the lock, so two posts with one key at
    // once do not both pass.
    const existing = await tx.journalEntry.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId, idempotencyKey: input.idempotencyKey }
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    })
    if (existing !== null) {
      if (!this.sameRequest(existing, input, memo, lines)) {
        throw resourceConflict('the idempotency key belongs to another entry', {
          idempotencyKey: input.idempotencyKey
        })
      }
      return {
        id: existing.id,
        number: existing.number,
        entryDate: isoDay(existing.entryDate),
        periodId: existing.periodId,
        type: existing.type as JournalEntryType,
        totalCents: existing.totalCents,
        hash: existing.hash,
        replayed: true
      }
    }

    // A year the calendar does not hold is a bad request, not a period made years ahead
    const year = Number(input.entryDate.slice(0, 4))
    if (year < FinanceLimits.MIN_YEAR || year > FinanceLimits.MAX_YEAR) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'the date is outside the years of the calendar',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const dateProblem = entryDateProblem(input.entryDate, settings.calendar)
    if (dateProblem !== null) throw financeRefusal(dateProblem)

    const period = await this.openPeriod(tx, organizationId, input.entryDate)
    await this.checkAccounts(tx, organizationId, input, lines)
    if (reversesEntryId === null) await this.checkDimensions(tx, organizationId, lines)

    const totalCents = lines.reduce((sum, line) => sum + line.debitCents, 0)
    const sourceDate = input.sourceDate ?? null
    const hash = hashEntry({
      number: settings.nextNumber,
      entryDate: input.entryDate,
      periodId: period.id,
      totalCents,
      currency: FinanceCurrency,
      type: input.type,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      sourceDate,
      reversesEntryId,
      idempotencyKey: input.idempotencyKey,
      memo,
      origin: input.origin,
      createdBy: input.createdBy,
      prevHash: settings.lastHash,
      lines
    })
    const entry = await tx.journalEntry.create({
      data: {
        organizationId,
        number: settings.nextNumber,
        entryDate: dayDate(input.entryDate),
        periodId: period.id,
        type: input.type,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        sourceDate: sourceDate === null ? null : dayDate(sourceDate),
        idempotencyKey: input.idempotencyKey,
        reversesEntryId,
        memo,
        currency: FinanceCurrency,
        totalCents,
        createdBy: input.createdBy,
        origin: input.origin,
        prevHash: settings.lastHash,
        hash
      },
      select: { id: true }
    })
    // The lines name their organization themselves: a composite key, which a nested create cannot say
    await tx.journalLine.createMany({
      data: lines.map(line => ({ ...line, entryId: entry.id, organizationId }))
    })

    const payload = {
      organizationId,
      entryId: entry.id,
      number: Number(settings.nextNumber),
      type: input.type,
      reversesEntryId,
      actor: { type: input.origin, id: input.createdBy }
    }
    this.events.publish(tx, Events.FINANCE_ENTRY_POSTED, payload)
    if (reversesEntryId !== null) this.events.publish(tx, Events.FINANCE_ENTRY_REVERSED, payload)
    return {
      id: entry.id,
      number: settings.nextNumber,
      entryDate: input.entryDate,
      periodId: period.id,
      type: input.type,
      totalCents,
      hash,
      replayed: false
    }
  }

  // Whether a stored entry is what this call asks for: the fields a person or a source chooses, and every line. The number,
  // the hash, the author and the period follow from them (or from when it was posted) and are not compared.
  private sameRequest(
    stored: {
      entryDate: Date
      sourceDate: Date | null
      type: string
      createdBy: string | null
      origin: string
      sourceType: string | null
      sourceId: string | null
      memo: string | null
      lines: readonly StoredLine[]
    },
    input: PostEntryInput,
    memo: string | null,
    lines: readonly StoredLine[]
  ): boolean {
    const same = (x: StoredLine, y: StoredLine): boolean =>
      x.lineNo === y.lineNo &&
      x.accountId === y.accountId &&
      x.debitCents === y.debitCents &&
      x.creditCents === y.creditCents &&
      x.storeId === y.storeId &&
      x.partyType === y.partyType &&
      x.partyId === y.partyId &&
      x.taxRateId === y.taxRateId &&
      x.memo === y.memo
    return (
      // The date the caller asked for (every entry of this step is dated by the caller; Step 4B.6 decides how a retry of an
      // automatic posting that moved to the open period is compared)
      isoDay(stored.entryDate) === input.entryDate &&
      (stored.sourceDate === null ? null : isoDay(stored.sourceDate)) ===
        (input.sourceDate ?? null) &&
      (stored.type as JournalEntryType) === input.type &&
      // Another author asking for the same key is not a retry of the first one's act
      stored.createdBy === input.createdBy &&
      (stored.origin as EntryOrigin) === input.origin &&
      stored.sourceType === (input.sourceType ?? null) &&
      stored.sourceId === (input.sourceId ?? null) &&
      stored.memo === memo &&
      stored.lines.length === lines.length &&
      stored.lines.every((line, index) => {
        const other = lines[index]
        return other !== undefined && same(line, other)
      })
    )
  }

  // The period of a date, made when it does not exist yet (periods are created on demand, TDD_18 §2.4), and refused when
  // it is closed. The insert skips a period another request made a moment ago.
  private async openPeriod(
    tx: PrismaTransaction,
    organizationId: string,
    entryDate: string
  ): Promise<{ id: string }> {
    const bounds = periodOfDate(entryDate)
    await tx.fiscalPeriod.createMany({
      data: [
        {
          organizationId,
          year: bounds.year,
          month: bounds.month,
          startsOn: dayDate(bounds.startsOn),
          endsOn: dayDate(bounds.endsOn)
        }
      ],
      skipDuplicates: true
    })
    const period = await tx.fiscalPeriod.findUniqueOrThrow({
      where: {
        organizationId_year_month: { organizationId, year: bounds.year, month: bounds.month }
      },
      select: { id: true, status: true }
    })
    if (period.status !== (PeriodStatus.OPEN as string)) {
      throw financeRefusal(ErrorCodes.FINANCE_PERIOD_CLOSED, {
        period: `${bounds.year}-${bounds.month}`
      })
    }
    return period
  }

  // The party and the tax rate of a line name rows of other tables: they are looked up in the organization here, so that no line
  // points across it (the key of the database holds the rate too, this gives the typed answer). A customer and a carrier
  // connection belong to a store of the organization; the suppliers have no table until Step 4B.5, which adds their check, and a
  // line that names one is refused until then.
  private async checkDimensions(
    tx: PrismaTransaction,
    organizationId: string,
    lines: readonly StoredLine[]
  ): Promise<void> {
    // A supplier is not a row until Step 4B.5: no line names one before its table exists
    if (lines.some(line => line.partyType === PartyType.SUPPLIER)) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'a supplier cannot be named by an entry before its table exists',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    // A tax rate is one of the organization (another organization's is a rate that does not exist)
    const rates = [
      ...new Set(lines.flatMap(line => (line.taxRateId === null ? [] : [line.taxRateId])))
    ]
    if (rates.length > 0) {
      const found = await tx.taxRate.count({ where: { id: { in: rates }, organizationId } })
      if (found !== rates.length) throw resourceNotFound('tax rate')
    }
    const idsOf = (type: PartyType): string[] => [
      ...new Set(
        lines.flatMap(line =>
          line.partyType === (type as string) && line.partyId !== null ? [line.partyId] : []
        )
      )
    ]
    const customers = idsOf(PartyType.CUSTOMER)
    if (customers.length > 0) {
      const found = await tx.customer.count({
        where: { id: { in: customers }, store: { organizationId } }
      })
      if (found !== customers.length) throw resourceNotFound('customer')
    }
    const carriers = idsOf(PartyType.CARRIER_CONNECTION)
    if (carriers.length > 0) {
      const found = await tx.carrierConnection.count({
        where: { id: { in: carriers }, store: { organizationId } }
      })
      if (found !== carriers.length) throw resourceNotFound('carrier connection')
    }
  }

  // Every account of the lines exists in the organization (another organization's is an account that does not exist), takes
  // entries and is on, and every store of a line is one of the organization. The inactive account takes the reversal of an
  // entry that used it and nothing else (TDD_18 §2.5), as the trigger of the lines holds.
  private async checkAccounts(
    tx: PrismaTransaction,
    organizationId: string,
    input: PostEntryInput,
    lines: readonly StoredLine[]
  ): Promise<void> {
    const accountIds = [...new Set(lines.map(line => line.accountId))]
    const accounts = await tx.ledgerAccount.findMany({
      where: { organizationId, id: { in: accountIds } },
      select: { id: true, active: true, isPostable: true }
    })
    if (accounts.length !== accountIds.length) throw resourceNotFound('ledger account')
    for (const account of accounts) {
      if (!account.isPostable) {
        throw financeRefusal(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE, { accountId: account.id })
      }
      if (!account.active && input.type !== JournalEntryType.REVERSAL) {
        throw financeRefusal(ErrorCodes.FINANCE_ACCOUNT_INACTIVE, { accountId: account.id })
      }
    }
    const storeIds = [
      ...new Set(lines.flatMap(line => (line.storeId === null ? [] : [line.storeId])))
    ]
    if (storeIds.length > 0) {
      const found = await tx.store.count({ where: { organizationId, id: { in: storeIds } } })
      if (found !== storeIds.length) throw resourceNotFound('store')
    }
  }
}
