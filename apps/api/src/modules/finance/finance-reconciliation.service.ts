import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  inSavepoint,
  isUniqueViolation,
  type PrismaTransaction,
  PrismaService
} from '@platform/core/database'
import {
  BankGroupRule,
  BankLineFilters,
  BankStatementLimits,
  BankStatementTransaction,
  BankTriggerPrefixes,
  canPair,
  DAY_MS,
  groupProblems,
  FinanceConflicts,
  FinanceResourceTypes,
  FinanceTransactionKind,
  type MatchBookLine,
  type MatchStatementLine,
  type MatchSuggestion,
  ReconciliationMatchStatus,
  suggestMatches,
  unambiguousExactPairs
} from '@platform/core/domain'
import { PlatformException, resourceConflict, resourceNotFound } from '@platform/core/errors'
import { dateToDay } from '@platform/core/finance'

import type { Actor } from '../tenancy'

import {
  type BankBookCandidatesQuery,
  type BankGroupBody,
  type BankPairBody,
  type BankStatusQuery,
  type ListBankLinesQuery
} from './finance-bank.schemas'

const CONFIRMED = ReconciliationMatchStatus.CONFIRMED
const REJECTED = ReconciliationMatchStatus.REJECTED

const isoDay = dateToDay
const conflict = (message: string, kind: string) => resourceConflict(message, { conflict: kind })

// A line of the journal that nothing reversed and that is no reversal: a voided transaction never reached the bank, so neither of its
// two entries is a candidate for a statement line
const LIVE_ENTRY = { reversesEntryId: null, reversedBy: null } as const

// What a refusal of the database or a lost race is in the answers of the reconciliation, or null when it is something else. The prefix of
// the trigger is the LAST one of the message; a deadlock is two decisions that took each other's lock.
const TRIGGER_PREFIX = new RegExp(`\\b(${Object.values(BankTriggerPrefixes).join('|')}):`, 'g')
function raceRefusal(error: unknown): PlatformException | null {
  if (error instanceof PlatformException) return null
  const message = error instanceof Error ? error.message : ''
  const prefix = [...message.matchAll(TRIGGER_PREFIX)].at(-1)?.[1]
  // The statement line was matched in the same moment, as a pair or as a group: the same answer as when it is read matched
  if (/RECONCILIATION_(?:MATCH|GROUP): the statement line is matched/.test(message)) {
    return conflict(
      'the statement line is matched already',
      FinanceConflicts.BANK_LINE_ALREADY_MATCHED
    )
  }
  if (prefix === BankTriggerPrefixes.MATCH || prefix === BankTriggerPrefixes.ENTRY_RECONCILED) {
    return conflict('the lines cannot be the same movement', FinanceConflicts.BANK_PAIR_NOT_ALLOWED)
  }
  // The group the database refused when the transaction ended (it does not add up, or the statement line was matched in the same moment)
  if (prefix === BankTriggerPrefixes.GROUP) {
    return conflict('the lines cannot be one group', FinanceConflicts.BANK_GROUP_NOT_ALLOWED)
  }
  if (/deadlock detected|40P01/.test(message)) {
    return conflict(
      'the books changed in the same moment: read again',
      FinanceConflicts.BANK_CHANGED
    )
  }
  return null
}

export interface BankSuggestionView extends MatchSuggestion {
  entryId: string
  entryNumber: string
  entryDate: string
  memo: string | null
  signedCents: number
}

export interface BankLineView {
  id: string
  importId: string
  lineNo: number
  postedOn: string
  amountCents: number
  description: string | null
  reference: string | null
  // The decision that matched it (a person's), or null
  match: {
    id: string
    journalLineId: string
    entryId: string
    entryNumber: string
    entryDate: string
    decidedBy: string
    decidedAt: string
  } | null
  // Set when the line was matched with a group of lines of the books (`match` is then the lead of the group, and undoing it takes the whole
  // group back): the pieces of the group
  group: {
    id: string
    pieces: {
      matchId: string
      journalLineId: string
      entryId: string
      entryNumber: string
      entryDate: string
      signedCents: number
    }[]
  } | null
  suggestions: BankSuggestionView[]
}

export interface BankLinePage {
  items: BankLineView[]
  // The row to send as `after` for the next page, or null at the end
  next: number | null
  // The lines of the import by state (before the page and the filter)
  counts: { total: number; matched: number; unmatched: number; suggested: number }
}

// A line of the books a group can be chosen from (HC-121): the entry it belongs to and what it moves on the account, debit minus credit
export interface BankBookCandidateView {
  journalLineId: string
  entryId: string
  entryNumber: string
  entryDate: string
  memo: string | null
  documentNumber: string | null
  signedCents: number
}

export interface BankBookCandidatesView {
  items: BankBookCandidateView[]
  // There were more lines than `limit`: the oldest are not in the answer
  hasMore: boolean
}

export interface BankRegisterDraft {
  kind: FinanceTransactionKind
  occurredOn: string
  amountCents: number
  fromAccountId?: string
  toAccountId?: string
  documentNumber?: string
  memo?: string
}

export interface BankStatusView {
  accountId: string
  year: number
  month: number
  book: { lines: number; matched: number; unmatched: number; unmatchedCents: number }
  statement: { lines: number; matched: number; unmatched: number; unmatchedCents: number }
  // Every line of both sides has its pair, and there is at least a statement line
  reconciled: boolean
}

export interface BankDifferenceView {
  importId: string
  accountId: string
  closingOn: string
  statementBalanceCents: number
  bookBalanceCents: number
  // statement minus books
  differenceCents: number
  // What the lines left unmatched explain: money the bank has and the books do not (statement lines), and the other way round
  unmatchedStatement: { lines: number; cents: number }
  unmatchedBook: { lines: number; cents: number }
  // The difference that no unmatched line explains (a missing statement, an opening balance, a wrong amount)
  unexplainedCents: number
}

interface LineRow {
  id: string
  importId: string
  accountId: string
  lineNo: number
  postedOn: Date
  amountCents: number
  description: string | null
  reference: string | null
}

const LINE_SELECT = {
  id: true,
  importId: true,
  accountId: true,
  lineNo: true,
  postedOn: true,
  amountCents: true,
  description: true,
  reference: true
} as const

const BOOK_SELECT = {
  id: true,
  debitCents: true,
  creditCents: true,
  entry: {
    select: {
      id: true,
      number: true,
      entryDate: true,
      memo: true,
      transaction: { select: { documentNumber: true, memo: true } }
    }
  }
} as const

// The same, with what says whether the entry was reversed or is a reversal
const BOOK_WITH_REVERSAL_SELECT = {
  ...BOOK_SELECT,
  entry: {
    select: {
      ...BOOK_SELECT.entry.select,
      reversesEntryId: true,
      reversedBy: { select: { id: true } }
    }
  }
} as const

type BookRow = {
  id: string
  debitCents: number
  creditCents: number
  entry: {
    id: string
    number: bigint
    entryDate: Date
    memo: string | null
    transaction: { documentNumber: string | null; memo: string | null } | null
  }
}

// The reconciliation of a cash, bank or wallet account with its statement (TDD_18 §4.4). Everything here SUGGESTS or RECORDS a person's
// decision: nothing posts an entry, edits one or reconciles by itself, and the journal is never touched (a match is a row of its own).
// The organization is the guard's. Reconciling is read and decided with `finance:reconcile`; the date window of a suggestion is the one
// of the profile that read the file.
@Injectable()
export class FinanceReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  // ------------------------------------------------------------------------------------------------------ reading

  // The lines of an import with what the books suggest for each one that is not matched yet
  async lines(
    organizationId: string,
    importId: string,
    query: ListBankLinesQuery
  ): Promise<BankLinePage> {
    const found = await this.prisma.client.bankStatementImport.findFirst({
      where: { id: importId, organizationId },
      select: { id: true, accountId: true, profileId: true }
    })
    if (found === null) throw resourceNotFound('bank statement import')
    const rows = await this.prisma.client.bankStatementLine.findMany({
      where: { organizationId, importId },
      select: LINE_SELECT,
      orderBy: [{ lineNo: 'asc' }, { id: 'asc' }]
    })
    const state = await this.state(organizationId, found.accountId, found.profileId, rows)
    const views = rows.map(row => this.view(row, state))
    const counts = {
      total: views.length,
      matched: views.filter(view => view.match !== null).length,
      unmatched: views.filter(view => view.match === null).length,
      suggested: views.filter(view => view.match === null && view.suggestions.length > 0).length
    }
    const wanted = views.filter(view => {
      if (query.filter === BankLineFilters.MATCHED) return view.match !== null
      if (query.filter === BankLineFilters.UNMATCHED) return view.match === null
      if (query.filter === BankLineFilters.SUGGESTED) {
        return view.match === null && view.suggestions.length > 0
      }
      return true
    })
    const after = query.after
    const rest = after === undefined ? wanted : wanted.filter(view => view.lineNo > after)
    const items = rest.slice(0, query.limit)
    const last = items[items.length - 1]
    return {
      items,
      next: rest.length > items.length && last !== undefined ? last.lineNo : null,
      counts
    }
  }

  // The lines of the books of the account of a statement line that no confirmed decision holds and that no reversal touches, newest first.
  // No window of days: a group is chosen by a person and its lines can be weeks apart. The sum is not checked here (confirmGroup does).
  async bookCandidates(
    organizationId: string,
    lineId: string,
    query: BankBookCandidatesQuery
  ): Promise<BankBookCandidatesView> {
    const line = await this.requireLine(this.prisma.client, organizationId, lineId)
    const rows = await this.prisma.client.journalLine.findMany({
      where: {
        organizationId,
        accountId: line.accountId,
        matches: { none: { status: CONFIRMED } },
        entry: LIVE_ENTRY
      },
      select: BOOK_SELECT,
      orderBy: [{ entry: { entryDate: 'desc' } }, { entry: { number: 'desc' } }, { id: 'asc' }],
      take: query.limit + 1
    })
    return {
      items: rows.slice(0, query.limit).map(row => ({
        journalLineId: row.id,
        entryId: row.entry.id,
        entryNumber: String(row.entry.number),
        entryDate: isoDay(row.entry.entryDate),
        memo: row.entry.memo,
        documentNumber: row.entry.transaction?.documentNumber ?? null,
        signedCents: row.debitCents - row.creditCents
      })),
      hasMore: rows.length > query.limit
    }
  }

  // The transaction of 4B.4a that an unmatched line would be, prefilled: what the bank says is the date, the amount, the account and the
  // reference; the memo is empty unless the person asks for the description; the category, the tax and the rest are the person's. Nothing is posted here.
  async registerDraft(
    organizationId: string,
    lineId: string,
    useDescriptionAsMemo = false
  ): Promise<BankRegisterDraft> {
    const line = await this.requireLine(this.prisma.client, organizationId, lineId)
    const matched = await this.prisma.client.reconciliationMatch.findFirst({
      where: { organizationId, statementLineId: lineId, status: CONFIRMED },
      select: { id: true }
    })
    if (matched !== null) {
      throw conflict('the line is matched already', FinanceConflicts.BANK_LINE_MATCHED)
    }
    const incoming = line.amountCents > 0
    return {
      kind: incoming ? FinanceTransactionKind.INCOME : FinanceTransactionKind.EXPENSE,
      occurredOn: isoDay(line.postedOn),
      amountCents: Math.abs(line.amountCents),
      ...(incoming ? { toAccountId: line.accountId } : { fromAccountId: line.accountId }),
      ...(line.reference === null ? {} : { documentNumber: line.reference }),
      // The bank's text is the memo only when the person asks for it
      ...(!useDescriptionAsMemo || line.description === null || line.description.trim() === ''
        ? {}
        : { memo: line.description })
    }
  }

  // The state of the reconciliation of an account in a calendar month: the lines of the books and of the statement, how many have
  // their pair and what the others add up to. The months are the calendar's, like the fiscal periods.
  async status(organizationId: string, query: BankStatusQuery): Promise<BankStatusView> {
    await this.requireCashAccount(organizationId, query.accountId)
    const first = new Date(Date.UTC(query.year, query.month - 1, 1))
    const last = new Date(Date.UTC(query.year, query.month, 0))
    const bookWhere = {
      organizationId,
      accountId: query.accountId,
      entry: { entryDate: { gte: first, lte: last }, ...LIVE_ENTRY }
    }
    const statementWhere = {
      organizationId,
      accountId: query.accountId,
      postedOn: { gte: first, lte: last }
    }
    const confirmed = { some: { status: CONFIRMED } }
    const [bookTotal, bookMatched, bookOpen, statementTotal, statementMatched, statementOpen] =
      await Promise.all([
        this.prisma.client.journalLine.count({ where: bookWhere }),
        this.prisma.client.journalLine.count({ where: { ...bookWhere, matches: confirmed } }),
        this.prisma.client.journalLine.aggregate({
          where: { ...bookWhere, matches: { none: { status: CONFIRMED } } },
          _sum: { debitCents: true, creditCents: true },
          _count: true
        }),
        this.prisma.client.bankStatementLine.count({ where: statementWhere }),
        this.prisma.client.bankStatementLine.count({
          where: { ...statementWhere, matches: confirmed }
        }),
        this.prisma.client.bankStatementLine.aggregate({
          where: { ...statementWhere, matches: { none: { status: CONFIRMED } } },
          _sum: { amountCents: true },
          _count: true
        })
      ])
    const book = {
      lines: bookTotal,
      matched: bookMatched,
      unmatched: bookOpen._count,
      unmatchedCents: (bookOpen._sum.debitCents ?? 0) - (bookOpen._sum.creditCents ?? 0)
    }
    const statement = {
      lines: statementTotal,
      matched: statementMatched,
      unmatched: statementOpen._count,
      unmatchedCents: statementOpen._sum.amountCents ?? 0
    }
    return {
      accountId: query.accountId,
      year: query.year,
      month: query.month,
      book,
      statement,
      reconciled: statement.lines > 0 && book.unmatched === 0 && statement.unmatched === 0
    }
  }

  // The balance of the books against the balance the statement ended with, at the day the person gave
  async difference(organizationId: string, importId: string): Promise<BankDifferenceView> {
    const found = await this.prisma.client.bankStatementImport.findFirst({
      where: { id: importId, organizationId },
      select: { id: true, accountId: true, closingBalanceCents: true, closingOn: true }
    })
    if (found === null) throw resourceNotFound('bank statement import')
    if (found.closingBalanceCents === null || found.closingOn === null) {
      throw conflict(
        'the statement was imported without its closing balance',
        FinanceConflicts.BANK_NO_CLOSING_BALANCE
      )
    }
    const { accountId, closingOn } = found
    const [books, bookOpen, statementOpen] = await Promise.all([
      this.prisma.client.journalLine.aggregate({
        where: { organizationId, accountId, entry: { entryDate: { lte: closingOn } } },
        _sum: { debitCents: true, creditCents: true }
      }),
      this.prisma.client.journalLine.aggregate({
        where: {
          organizationId,
          accountId,
          // On the books at that day and with no pair on the statement by then: a pair that straddles the day (booked before it, posted
          // by the bank after it) is still a difference at the day, and is explained as such
          matches: { none: { status: CONFIRMED, statementLine: { postedOn: { lte: closingOn } } } },
          // Live AT that day: an entry reversed after it was still on the books then
          entry: {
            entryDate: { lte: closingOn },
            reversesEntryId: null,
            NOT: { reversedBy: { is: { entryDate: { lte: closingOn } } } }
          }
        },
        _sum: { debitCents: true, creditCents: true },
        _count: true
      }),
      this.prisma.client.bankStatementLine.aggregate({
        where: {
          organizationId,
          accountId,
          postedOn: { lte: closingOn },
          matches: {
            none: { status: CONFIRMED, journalLine: { entry: { entryDate: { lte: closingOn } } } }
          }
        },
        _sum: { amountCents: true },
        _count: true
      })
    ])
    const bookBalance = (books._sum.debitCents ?? 0) - (books._sum.creditCents ?? 0)
    const difference = found.closingBalanceCents - bookBalance
    const unmatchedBook = {
      lines: bookOpen._count,
      cents: (bookOpen._sum.debitCents ?? 0) - (bookOpen._sum.creditCents ?? 0)
    }
    const unmatchedStatement = {
      lines: statementOpen._count,
      cents: statementOpen._sum.amountCents ?? 0
    }
    // A group that straddles the closing day (the statement line by it, one of its lines of the books after it) is matched only when ALL of
    // it was on the books: the lines of it that were are still a difference at the day, with the statement line (HC-121)
    const late = await this.prisma.client.reconciliationMatch.findMany({
      where: {
        organizationId,
        status: CONFIRMED,
        groupId: { not: null },
        statementLine: { accountId, postedOn: { lte: closingOn } },
        journalLine: { entry: { entryDate: { gt: closingOn } } }
      },
      select: { groupId: true },
      distinct: ['groupId']
    })
    if (late.length > 0) {
      const early = await this.prisma.client.reconciliationMatch.findMany({
        where: {
          organizationId,
          status: CONFIRMED,
          groupId: { in: late.map(row => row.groupId).filter((id): id is string => id !== null) },
          journalLine: {
            entry: {
              entryDate: { lte: closingOn },
              reversesEntryId: null,
              NOT: { reversedBy: { is: { entryDate: { lte: closingOn } } } }
            }
          }
        },
        select: {
          statementLineId: true,
          journalLine: { select: { debitCents: true, creditCents: true } }
        }
      })
      const statementIds = [...new Set(early.map(row => row.statementLineId))]
      const statements = await this.prisma.client.bankStatementLine.findMany({
        where: { organizationId, id: { in: statementIds } },
        select: { amountCents: true }
      })
      unmatchedBook.lines += early.length
      unmatchedBook.cents += early.reduce(
        (total, row) => total + row.journalLine.debitCents - row.journalLine.creditCents,
        0
      )
      unmatchedStatement.lines += statements.length
      unmatchedStatement.cents += statements.reduce((total, row) => total + row.amountCents, 0)
    }
    return {
      importId,
      accountId,
      closingOn: isoDay(closingOn),
      statementBalanceCents: found.closingBalanceCents,
      bookBalanceCents: bookBalance,
      differenceCents: difference,
      unmatchedStatement,
      unmatchedBook,
      unexplainedCents: difference - (unmatchedStatement.cents - unmatchedBook.cents)
    }
  }

  // ------------------------------------------------------------------------------------------------------ deciding

  // A person says the statement line and the line of the books are the same movement. The server checks the pair against the rules
  // whatever the screen sent (the account, the amount and direction, the window, nothing matched already); the database checks again.
  async confirm(
    organizationId: string,
    lineId: string,
    body: BankPairBody,
    actor: Actor
  ): Promise<BankLineView> {
    const { id: matchId } = await this.decide(
      organizationId,
      lineId,
      body.journalLineId,
      CONFIRMED,
      actor
    )
    this.audit.log({
      action: AuditAction.FINANCE_RECONCILIATION_CONFIRMED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.RECONCILIATION_MATCH,
      resourceId: matchId,
      metadata: { statementLineId: lineId, journalLineId: body.journalLineId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.lineView(organizationId, lineId)
  }

  // A person says ONE statement line is the sum of SEVERAL lines of the books of the same account (HC-121): a deposit that groups three
  // collections, or one net of a fee that was booked as an expense from the same account. The signed sum of the lines has to be exactly the
  // amount of the statement line, whatever the screen sent (the database checks it again when the transaction ends and refuses what does
  // not add up). The rows are written in the order of the ENTRIES of the lines (the database locks entries), so that two groups that share
  // entries never take their locks in opposite orders; the first of them is the lead of the group. There is no window
  // of days here: the person chose the lines one by one. The group is taken back whole (`undo` on any of its decisions).
  async confirmGroup(
    organizationId: string,
    lineId: string,
    body: BankGroupBody,
    actor: Actor
  ): Promise<BankLineView> {
    const requested = [...body.journalLineIds].sort()
    const groupId = randomUUID()
    try {
      await inSavepoint(() =>
        this.prisma.transaction(async tx => {
          const line = await this.requireLine(tx, organizationId, lineId)
          const books = await tx.journalLine.findMany({
            where: { id: { in: requested }, organizationId, accountId: line.accountId },
            select: BOOK_WITH_REVERSAL_SELECT,
            orderBy: [{ id: 'asc' }]
          })
          const byId = new Map(books.map(book => [book.id, book]))
          // A line of another account or organization is not a candidate and does not exist for this request
          if (byId.size !== new Set(requested).size) throw resourceNotFound('journal line')
          const lines = requested.map(id => ({
            id,
            signedCents: (byId.get(id)?.debitCents ?? 0) - (byId.get(id)?.creditCents ?? 0)
          }))
          const problems = groupProblems({ statementCents: line.amountCents, lines })
          // The shape of the group first (a line named twice, too few, too many): a sum that is wrong for a group that cannot be one is
          // not the answer to give, because what the person has to change is the group and not an amount
          if (problems.some(rule => rule !== BankGroupRule.SUM)) {
            throw conflict('the lines cannot be one group', FinanceConflicts.BANK_GROUP_NOT_ALLOWED)
          }
          if (problems.includes(BankGroupRule.SUM)) {
            throw resourceConflict('the lines do not add up to the statement line', {
              conflict: FinanceConflicts.BANK_GROUP_SUM_MISMATCH,
              statementCents: line.amountCents,
              sumCents: lines.reduce((total, each) => total + each.signedCents, 0)
            })
          }
          const dead = books.some(
            book => book.entry.reversesEntryId !== null || book.entry.reversedBy !== null
          )
          if (problems.length > 0 || dead) {
            throw conflict('the lines cannot be one group', FinanceConflicts.BANK_GROUP_NOT_ALLOWED)
          }
          const taken = await tx.reconciliationMatch.findFirst({
            where: {
              organizationId,
              status: CONFIRMED,
              OR: [{ statementLineId: lineId }, { journalLineId: { in: requested } }]
            },
            select: { statementLineId: true }
          })
          if (taken !== null) {
            throw conflict(
              taken.statementLineId === lineId
                ? 'the statement line is matched already'
                : 'a line of the books is matched already',
              taken.statementLineId === lineId
                ? FinanceConflicts.BANK_LINE_ALREADY_MATCHED
                : FinanceConflicts.BANK_BOOK_LINE_ALREADY_MATCHED
            )
          }
          // A rejection of one of these pairs is retired by choosing it, like for a pair
          await tx.reconciliationMatch.updateMany({
            where: {
              organizationId,
              statementLineId: lineId,
              journalLineId: { in: requested },
              status: REJECTED
            },
            data: {
              status: ReconciliationMatchStatus.UNDONE,
              undoneBy: actor.userId,
              undoneAt: new Date()
            }
          })
          const ordered = [...books].sort(
            (x, y) => x.entry.id.localeCompare(y.entry.id) || x.id.localeCompare(y.id)
          )
          // One statement per row, in that order: a single INSERT of many rows has no promised order
          for (const [index, book] of ordered.entries()) {
            await tx.reconciliationMatch.create({
              data: {
                organizationId,
                statementLineId: lineId,
                journalLineId: book.id,
                status: CONFIRMED,
                decidedBy: actor.userId,
                groupId,
                isGroupLead: index === 0
              }
            })
          }
        })
      )
    } catch (error) {
      const refused = raceRefusal(error)
      if (refused !== null) throw refused
      if (isUniqueViolation(error)) {
        // Two decisions took the same line at the same moment and a unique index held: what is there now says the answer
        const takenLine = await this.prisma.client.reconciliationMatch.findFirst({
          where: { organizationId, statementLineId: lineId, status: CONFIRMED },
          select: { id: true }
        })
        if (takenLine !== null) {
          throw conflict(
            'the statement line is matched already',
            FinanceConflicts.BANK_LINE_ALREADY_MATCHED
          )
        }
        const takenBook = await this.prisma.client.reconciliationMatch.findFirst({
          where: { organizationId, journalLineId: { in: requested }, status: CONFIRMED },
          select: { id: true }
        })
        throw takenBook === null
          ? conflict(
              'the books changed in the same moment: read again',
              FinanceConflicts.BANK_CHANGED
            )
          : conflict(
              'a line of the books is matched already',
              FinanceConflicts.BANK_BOOK_LINE_ALREADY_MATCHED
            )
      }
      throw error
    }
    // The audit row names the lead decision of the group (a row of the table, like the undo of the group names the decision it was asked
    // with); the group is in the metadata
    const lead = await this.prisma.client.reconciliationMatch.findFirst({
      where: { organizationId, groupId, isGroupLead: true },
      select: { id: true }
    })
    this.audit.log({
      action: AuditAction.FINANCE_RECONCILIATION_GROUP_CONFIRMED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.RECONCILIATION_MATCH,
      resourceId: lead?.id ?? groupId,
      metadata: { statementLineId: lineId, groupId, journalLineIds: requested },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.lineView(organizationId, lineId)
  }

  // A person says this suggestion is not it: the pair is never suggested again (until the decision is taken back)
  async reject(
    organizationId: string,
    lineId: string,
    body: BankPairBody,
    actor: Actor
  ): Promise<BankLineView> {
    const { id: matchId, created } = await this.decide(
      organizationId,
      lineId,
      body.journalLineId,
      REJECTED,
      actor
    )
    // The same rejection again changed nothing and says nothing
    if (created) {
      this.audit.log({
        action: AuditAction.FINANCE_RECONCILIATION_REJECTED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.RECONCILIATION_MATCH,
        resourceId: matchId,
        metadata: { statementLineId: lineId, journalLineId: body.journalLineId },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.lineView(organizationId, lineId)
  }

  // Takes a decision back, once: the row stays as history and the line is open again
  async undo(organizationId: string, matchId: string, actor: Actor): Promise<BankLineView> {
    const match = await this.prisma.client.reconciliationMatch.findFirst({
      where: { id: matchId, organizationId },
      select: {
        id: true,
        status: true,
        statementLineId: true,
        journalLineId: true,
        groupId: true
      }
    })
    if (match === null) throw resourceNotFound('reconciliation decision')
    // A group is taken back whole in one statement: the database checks it at the commit, and a group with one piece left would not add up
    const taken = await this.prisma.client.reconciliationMatch.updateMany({
      where:
        match.groupId === null
          ? { id: matchId, organizationId, status: { in: [CONFIRMED, REJECTED] } }
          : { organizationId, groupId: match.groupId, status: CONFIRMED },
      data: {
        status: ReconciliationMatchStatus.UNDONE,
        undoneBy: actor.userId,
        undoneAt: new Date()
      }
    })
    if (taken.count === 0) {
      throw conflict(
        'the decision was taken back already',
        FinanceConflicts.BANK_DECISION_ALREADY_UNDONE
      )
    }
    this.audit.log({
      action: AuditAction.FINANCE_RECONCILIATION_UNDONE,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.RECONCILIATION_MATCH,
      resourceId: matchId,
      metadata: {
        was: match.status,
        statementLineId: match.statementLineId,
        journalLineId: match.journalLineId,
        ...(match.groupId === null ? {} : { groupId: match.groupId })
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.lineView(organizationId, match.statementLineId)
  }

  // Confirms, in one request, every line of the import whose suggestion is the only one, exact (the same day, or the reference is in
  // the books) and wanted by no other line. What has two possibilities is left for a person to choose.
  async confirmExact(
    organizationId: string,
    importId: string,
    actor: Actor
  ): Promise<{ confirmed: number; left: number }> {
    const found = await this.prisma.client.bankStatementImport.findFirst({
      where: { id: importId, organizationId },
      select: { id: true, accountId: true, profileId: true }
    })
    if (found === null) throw resourceNotFound('bank statement import')
    try {
      const done = await this.prisma.transaction(async tx => {
        const rows = await tx.bankStatementLine.findMany({
          where: { organizationId, importId },
          select: LINE_SELECT,
          orderBy: [{ lineNo: 'asc' }, { id: 'asc' }]
        })
        // Whether a line of the books is wanted by ANOTHER line is judged among every open line of the account that can reach it, of
        // this import or of any other: a line of another statement that has the same only candidate is a doubt
        const ownWindow = await this.windowOfProfile(tx, organizationId, found.profileId)
        // The widest window any profile of the account has: a line of another statement that could reach the line of the books under
        // ITS window is a doubt too
        const widest = await tx.bankImportProfile.aggregate({
          where: { organizationId, accountId: found.accountId },
          _max: { dateWindowDays: true }
        })
        const window = Math.max(
          ownWindow,
          widest._max.dateWindowDays ?? 0,
          // an import whose profile was deleted since is read with the default window
          BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS
        )
        const days = rows.map(row => row.postedOn.getTime())
        const earliest = days.reduce((least, day) => Math.min(least, day), Number.POSITIVE_INFINITY)
        const latest = days.reduce((most, day) => Math.max(most, day), Number.NEGATIVE_INFINITY)
        const reach = 2 * window * DAY_MS
        const others =
          rows.length === 0
            ? []
            : await tx.bankStatementLine.findMany({
                where: {
                  organizationId,
                  accountId: found.accountId,
                  importId: { not: importId },
                  postedOn: { gte: new Date(earliest - reach), lte: new Date(latest + reach) },
                  matches: { none: { status: CONFIRMED } }
                },
                select: LINE_SELECT,
                orderBy: [{ id: 'asc' }]
              })
        const state = await this.state(
          organizationId,
          found.accountId,
          found.profileId,
          [...rows, ...others],
          tx,
          // Every suggestion counts as a claim, not the first few that a screen shows
          { window, truncate: false }
        )
        const inThisImport = new Set(rows.map(row => row.id))
        const open = [...rows, ...others].filter(row => !state.matched.has(row.id))
        const pairs = unambiguousExactPairs(
          new Map(open.map(row => [row.id, state.suggestions.get(row.id) ?? []]))
        )
          .filter(pair => inThisImport.has(pair.lineId))
          // Under the window of the profile that read THIS file, not the widest one that was used to find the doubts
          .filter(pair => {
            const only = state.suggestions.get(pair.lineId)?.[0]
            return only !== undefined && only.dayDifference <= ownWindow
          })
          .slice(0, BankStatementLimits.MAX_BULK_CONFIRM)
          // The database takes a lock per entry of each pair: two requests that take them in one order cannot wait on each other
          .sort((a, b) =>
            (state.book.get(a.bookLineId)?.entry.id ?? '').localeCompare(
              state.book.get(b.bookLineId)?.entry.id ?? ''
            )
          )
          .map(pair => ({ ...pair, id: randomUUID() }))
        if (pairs.length > 0) {
          await tx.reconciliationMatch.createMany({
            data: pairs.map(pair => ({
              id: pair.id,
              organizationId,
              statementLineId: pair.lineId,
              journalLineId: pair.bookLineId,
              status: CONFIRMED,
              decidedBy: actor.userId
            }))
          })
        }
        return {
          confirmed: pairs.length,
          left: open.filter(row => inThisImport.has(row.id)).length - pairs.length,
          pairs
        }
      }, BankStatementTransaction)
      if (done.confirmed > 0) {
        this.audit.log({
          action: AuditAction.FINANCE_RECONCILIATION_CONFIRMED,
          actor: { userId: actor.userId },
          organizationId,
          storeId: actor.storeId,
          resourceType: FinanceResourceTypes.BANK_IMPORT,
          resourceId: importId,
          // Which line was paired with which, and under what id each decision was made: the audit can tell them apart
          metadata: {
            importId,
            confirmed: done.confirmed,
            bulk: true,
            matches: done.pairs.map(pair => ({
              id: pair.id,
              statementLineId: pair.lineId,
              journalLineId: pair.bookLineId
            }))
          },
          ipAddress: actor.ipAddress,
          userAgent: actor.userAgent
        })
      }
      return { confirmed: done.confirmed, left: done.left }
    } catch (error) {
      // Another request took one of the lines in the same moment: nothing was confirmed, and the screen reads again
      if (isUniqueViolation(error)) {
        throw conflict(
          'a line was matched in the same moment',
          FinanceConflicts.BANK_LINE_ALREADY_MATCHED
        )
      }
      throw raceRefusal(error) ?? error
    }
  }

  // ------------------------------------------------------------------------------------------------------ inside

  private async decide(
    organizationId: string,
    lineId: string,
    journalLineId: string,
    status: typeof CONFIRMED | typeof REJECTED,
    actor: Actor
  ): Promise<{ id: string; created: boolean }> {
    try {
      return await inSavepoint(() =>
        this.prisma.transaction(async tx => {
          const line = await this.requireLine(tx, organizationId, lineId)
          const book = await tx.journalLine.findFirst({
            where: { id: journalLineId, organizationId, accountId: line.accountId },
            select: BOOK_WITH_REVERSAL_SELECT
          })
          // A line of another account or organization is not a candidate and does not exist for this request
          if (book === null) throw resourceNotFound('journal line')
          const profile = await this.windowOf(tx, organizationId, line.importId)
          const live = book.entry.reversesEntryId === null && book.entry.reversedBy === null
          if (
            !live ||
            !canPair(
              { postedOn: isoDay(line.postedOn), amountCents: line.amountCents },
              {
                entryDate: isoDay(book.entry.entryDate),
                signedCents: book.debitCents - book.creditCents
              },
              profile
            )
          ) {
            throw conflict(
              'the lines cannot be the same movement',
              FinanceConflicts.BANK_PAIR_NOT_ALLOWED
            )
          }
          if (status === CONFIRMED) {
            const taken = await tx.reconciliationMatch.findFirst({
              where: {
                organizationId,
                status: CONFIRMED,
                OR: [{ statementLineId: lineId }, { journalLineId }]
              },
              select: { statementLineId: true }
            })
            // A rejection of this pair is retired by choosing it: the history keeps it, and taking the choice back does not leave the pair hidden
            await tx.reconciliationMatch.updateMany({
              where: { organizationId, statementLineId: lineId, journalLineId, status: REJECTED },
              data: {
                status: ReconciliationMatchStatus.UNDONE,
                undoneBy: actor.userId,
                undoneAt: new Date()
              }
            })
            if (taken !== null) {
              throw conflict(
                taken.statementLineId === lineId
                  ? 'the statement line is matched already'
                  : 'the line of the books is matched already',
                taken.statementLineId === lineId
                  ? FinanceConflicts.BANK_LINE_ALREADY_MATCHED
                  : FinanceConflicts.BANK_BOOK_LINE_ALREADY_MATCHED
              )
            }
          } else {
            // A line that is matched takes no rejection: the confirmation is taken back first
            const matchedAlready = await tx.reconciliationMatch.findFirst({
              where: { organizationId, statementLineId: lineId, status: CONFIRMED },
              select: { id: true }
            })
            if (matchedAlready !== null) {
              throw conflict(
                'the statement line is matched already',
                FinanceConflicts.BANK_LINE_ALREADY_MATCHED
              )
            }
            // A pair that was rejected is rejected: the same request again finds the decision and writes nothing
            const again = await tx.reconciliationMatch.findFirst({
              where: { organizationId, statementLineId: lineId, journalLineId, status: REJECTED },
              select: { id: true }
            })
            if (again !== null) return { id: again.id, created: false }
          }
          const created = await tx.reconciliationMatch.create({
            data: {
              organizationId,
              statementLineId: lineId,
              journalLineId,
              status,
              decidedBy: actor.userId
            },
            select: { id: true }
          })
          return { id: created.id, created: true }
        })
      )
    } catch (error) {
      // A trigger of the database refused a pair that the checks above had let through (an entry reversed in the same moment)
      const refused = raceRefusal(error)
      if (refused !== null) throw refused
      if (isUniqueViolation(error))
        return this.afterRace(organizationId, lineId, journalLineId, status)
      throw error
    }
  }

  // Two requests decided the same line or pair at the same moment and a unique index held: what is there now says the answer
  private async afterRace(
    organizationId: string,
    lineId: string,
    journalLineId: string,
    status: typeof CONFIRMED | typeof REJECTED
  ): Promise<{ id: string; created: boolean }> {
    if (status === REJECTED) {
      const rejected = await this.prisma.client.reconciliationMatch.findFirst({
        where: { organizationId, statementLineId: lineId, journalLineId, status: REJECTED },
        select: { id: true }
      })
      // The same rejection made in the same moment: it is the one that is there
      if (rejected !== null) return { id: rejected.id, created: false }
    }
    const takenLine = await this.prisma.client.reconciliationMatch.findFirst({
      where: { organizationId, statementLineId: lineId, status: CONFIRMED },
      select: { id: true }
    })
    if (takenLine !== null) {
      throw conflict(
        'the statement line is matched already',
        FinanceConflicts.BANK_LINE_ALREADY_MATCHED
      )
    }
    const takenBook = await this.prisma.client.reconciliationMatch.findFirst({
      where: { organizationId, journalLineId, status: CONFIRMED },
      select: { id: true }
    })
    // Whoever held the index is gone (it rolled back): nothing is matched, and the screen reads again
    throw takenBook === null
      ? conflict('the books changed in the same moment: read again', FinanceConflicts.BANK_CHANGED)
      : conflict(
          'the line of the books is matched already',
          FinanceConflicts.BANK_BOOK_LINE_ALREADY_MATCHED
        )
  }

  private async requireLine(
    client: PrismaTransaction | PrismaService['client'],
    organizationId: string,
    lineId: string
  ): Promise<LineRow> {
    const line = await client.bankStatementLine.findFirst({
      where: { id: lineId, organizationId },
      select: LINE_SELECT
    })
    if (line === null) throw resourceNotFound('bank statement line')
    return line
  }

  private async requireCashAccount(organizationId: string, accountId: string): Promise<void> {
    const account = await this.prisma.client.ledgerAccount.findFirst({
      where: { id: accountId, organizationId },
      select: { cashKind: true }
    })
    if (account === null) throw resourceNotFound('ledger account')
    if (account.cashKind === null) {
      throw conflict(
        'only a cash, bank or wallet account is reconciled',
        FinanceConflicts.BANK_ACCOUNT_NOT_CASH
      )
    }
  }

  // The days a statement line and a line of the books may be apart: the window of the profile that read the file (a profile that was
  // deleted since leaves the default)
  private async windowOf(
    client: PrismaTransaction | PrismaService['client'],
    organizationId: string,
    importId: string
  ): Promise<number> {
    const read = await client.bankStatementImport.findFirst({
      where: { id: importId, organizationId },
      select: { profileId: true }
    })
    return this.windowOfProfile(client, organizationId, read?.profileId ?? null)
  }

  private async windowOfProfile(
    client: PrismaTransaction | PrismaService['client'],
    organizationId: string,
    profileId: string | null
  ): Promise<number> {
    if (profileId === null) return BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS
    const profile = await client.bankImportProfile.findFirst({
      where: { id: profileId, organizationId },
      select: { dateWindowDays: true }
    })
    return profile?.dateWindowDays ?? BankStatementLimits.DATE_WINDOW_DEFAULT_DAYS
  }

  // What is known about a set of lines of one account: which have a confirmed match, and what the books suggest for the others
  private async state(
    organizationId: string,
    accountId: string,
    profileId: string | null,
    rows: readonly LineRow[],
    client: PrismaTransaction | PrismaService['client'] = this.prisma.client,
    options: { window?: number; truncate?: boolean } = {}
  ): Promise<{
    matched: Map<string, MatchedRow>
    groups: Map<string, MatchedRow[]>
    suggestions: Map<string, BankSuggestionView[]>
    book: Map<string, BookRow>
  }> {
    const ids = rows.map(row => row.id)
    const decisions = await client.reconciliationMatch.findMany({
      where: {
        organizationId,
        statementLineId: { in: ids },
        status: { in: [CONFIRMED, REJECTED] }
      },
      select: {
        id: true,
        status: true,
        statementLineId: true,
        journalLineId: true,
        groupId: true,
        isGroupLead: true,
        decidedBy: true,
        decidedAt: true,
        journalLine: { select: BOOK_SELECT }
      },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }]
    })
    const matched = new Map<string, MatchedRow>()
    const groups = new Map<string, MatchedRow[]>()
    const rejected = new Set<string>()
    for (const decision of decisions) {
      if (decision.status === String(CONFIRMED)) {
        // The lead of a group stands for the line (`match`: undoing it takes the whole group back), the others are in its group
        if (!matched.has(decision.statementLineId) || decision.isGroupLead) {
          matched.set(decision.statementLineId, decision)
        }
        if (decision.groupId !== null) {
          groups.set(decision.statementLineId, [
            ...(groups.get(decision.statementLineId) ?? []),
            decision
          ])
        }
      } else rejected.add(`${decision.statementLineId}:${decision.journalLineId}`)
    }
    const open = rows.filter(row => !matched.has(row.id))
    const book = new Map<string, BookRow>()
    const suggestions = new Map<string, BankSuggestionView[]>()
    if (open.length > 0) {
      const window =
        options.window ?? (await this.windowOfProfile(client, organizationId, profileId))
      const days = open.map(row => row.postedOn.getTime())
      const from = new Date(
        days.reduce((least, day) => Math.min(least, day), Number.POSITIVE_INFINITY) -
          window * DAY_MS
      )
      const to = new Date(
        days.reduce((most, day) => Math.max(most, day), Number.NEGATIVE_INFINITY) + window * DAY_MS
      )
      const candidates = await client.journalLine.findMany({
        where: {
          organizationId,
          accountId,
          matches: { none: { status: CONFIRMED } },
          entry: { entryDate: { gte: from, lte: to }, ...LIVE_ENTRY }
        },
        select: BOOK_SELECT,
        orderBy: [{ id: 'asc' }]
      })
      for (const candidate of candidates) book.set(candidate.id, candidate)
      const toMatch: MatchBookLine[] = candidates.map(candidate => ({
        id: candidate.id,
        entryDate: isoDay(candidate.entry.entryDate),
        signedCents: candidate.debitCents - candidate.creditCents,
        texts: [
          candidate.entry.memo,
          candidate.entry.transaction?.documentNumber,
          candidate.entry.transaction?.memo
        ].filter((text): text is string => typeof text === 'string' && text !== '')
      }))
      const asLines: MatchStatementLine[] = open.map(row => ({
        id: row.id,
        postedOn: isoDay(row.postedOn),
        amountCents: row.amountCents,
        reference: row.reference
      }))
      for (const [lineId, list] of suggestMatches(asLines, toMatch, window, rejected)) {
        suggestions.set(
          lineId,
          (options.truncate === false
            ? list
            : list.slice(0, BankStatementLimits.MAX_SUGGESTIONS_PER_LINE)
          ).map(suggestion => {
            const row = book.get(suggestion.bookLineId)
            return {
              ...suggestion,
              entryId: row?.entry.id ?? '',
              entryNumber: String(row?.entry.number ?? ''),
              entryDate: row === undefined ? '' : isoDay(row.entry.entryDate),
              memo: row?.entry.memo ?? null,
              signedCents: row === undefined ? 0 : row.debitCents - row.creditCents
            }
          })
        )
      }
    }
    return { matched, groups, suggestions, book }
  }

  private view(
    row: LineRow,
    state: {
      matched: Map<string, MatchedRow>
      groups: Map<string, MatchedRow[]>
      suggestions: Map<string, BankSuggestionView[]>
    }
  ): BankLineView {
    const decision = state.matched.get(row.id)
    const pieces = state.groups.get(row.id)
    return {
      id: row.id,
      importId: row.importId,
      lineNo: row.lineNo,
      postedOn: isoDay(row.postedOn),
      amountCents: row.amountCents,
      description: row.description,
      reference: row.reference,
      match:
        decision === undefined
          ? null
          : {
              id: decision.id,
              journalLineId: decision.journalLineId,
              entryId: decision.journalLine.entry.id,
              entryNumber: String(decision.journalLine.entry.number),
              entryDate: isoDay(decision.journalLine.entry.entryDate),
              decidedBy: decision.decidedBy,
              decidedAt: decision.decidedAt.toISOString()
            },
      group:
        pieces === undefined || pieces[0]?.groupId === null || pieces[0]?.groupId === undefined
          ? null
          : {
              id: pieces[0].groupId,
              pieces: pieces.map(piece => ({
                matchId: piece.id,
                journalLineId: piece.journalLineId,
                entryId: piece.journalLine.entry.id,
                entryNumber: String(piece.journalLine.entry.number),
                entryDate: isoDay(piece.journalLine.entry.entryDate),
                signedCents: piece.journalLine.debitCents - piece.journalLine.creditCents
              }))
            },
      suggestions: state.suggestions.get(row.id) ?? []
    }
  }

  private async lineView(organizationId: string, lineId: string): Promise<BankLineView> {
    const row = await this.requireLine(this.prisma.client, organizationId, lineId)
    const read = await this.prisma.client.bankStatementImport.findFirst({
      where: { id: row.importId, organizationId },
      select: { profileId: true }
    })
    const state = await this.state(organizationId, row.accountId, read?.profileId ?? null, [row])
    return this.view(row, state)
  }
}

interface MatchedRow {
  id: string
  journalLineId: string
  groupId: string | null
  isGroupLead: boolean
  decidedBy: string
  decidedAt: Date
  journalLine: BookRow
}
