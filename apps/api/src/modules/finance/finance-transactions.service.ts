import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import type { Permission } from '@platform/core/auth'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  EntryOrigin,
  FinanceConflicts,
  FinanceIdempotencyKey,
  FinanceLimits,
  FinanceResourceTypes,
  FinanceSourceType,
  FinanceTransactionKind,
  JournalEntryType,
  type TaxRounding
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import {
  dateToDay,
  type TransactionAccount,
  type TransactionDraft,
  transactionLines,
  transactionProblems,
  TransactionRule,
  transactionTax,
  type TransactionTaxRate
} from '@platform/core/finance'
import { financeRefusal, LedgerService } from '@platform/core/finance-ledger'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type {
  ListTransactionsQuery,
  RecordTransactionBody,
  ReplaceTransactionBody,
  VoidTransactionBody
} from './finance.schemas'
import { dayDate, lockScope, requireTransactionPermission } from './finance.support'
import {
  TRANSACTION_SELECT,
  type TransactionPage,
  type TransactionRow,
  type TransactionView,
  transactionView
} from './finance.views'

const ENTRY_TYPE_OF_KIND: Readonly<Record<FinanceTransactionKind, JournalEntryType>> = {
  [FinanceTransactionKind.EXPENSE]: JournalEntryType.EXPENSE,
  [FinanceTransactionKind.INCOME]: JournalEntryType.INCOME,
  [FinanceTransactionKind.TRANSFER]: JournalEntryType.TRANSFER
}

const MS_PER_DAY = 86_400_000

const invalidTransaction = (problems: readonly string[]): PlatformException =>
  new PlatformException(
    ErrorCodes.VALIDATION_INVALID_INPUT,
    'the transaction breaks a rule of the books',
    HttpStatusCodes.BAD_REQUEST,
    { problems }
  )

// What the service wrote or found for a request, and whether it wrote it (a retry only finds)
interface Recorded {
  id: string
  replayed: boolean
  entryNumber: bigint | null
}

// The expenses, incomes and transfers a person registers by hand (TDD_18 §2.6, §4.3, E12). Each one is a row and ONE journal
// entry, written in the same transaction through LedgerService (the only writer of the journal). A transaction is never edited:
// voiding it reverses its entry, and changing it voids it and registers another in one request, so the journal tells the whole
// story. The organization is the guard's, never the body's; every id the body names is looked up inside it.
@Injectable()
export class FinanceTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService
  ) {}

  async list(organizationId: string, query: ListTransactionsQuery): Promise<TransactionPage> {
    const { cursor } = query
    const rows = await this.prisma.client.financeTransaction.findMany({
      where: {
        organizationId,
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.includeVoided ? {} : { voidedByEntryId: null }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              occurredOn: {
                ...(query.from === undefined ? {} : { gte: dayDate(query.from) }),
                ...(query.to === undefined ? {} : { lte: dayDate(query.to) })
              }
            }),
        ...(query.accountId === undefined
          ? {}
          : {
              OR: [
                { fromAccountId: query.accountId },
                { toAccountId: query.accountId },
                { categoryAccountId: query.accountId }
              ]
            }),
        ...(cursor === undefined
          ? {}
          : {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                  ]
                }
              ]
            })
      },
      select: TRANSACTION_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(transactionView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(organizationId: string, id: string): Promise<TransactionView> {
    return transactionView(await this.row(this.prisma.client, organizationId, id))
  }

  // Registers one. The key is the screen's: a retry (a double click, a lost answer) finds the first and writes nothing.
  async record(
    organizationId: string,
    body: RecordTransactionBody,
    actor: Actor,
    granted: readonly Permission[]
  ): Promise<TransactionView> {
    requireTransactionPermission(body.kind, granted)
    const recorded = await this.prisma.transaction(async tx => {
      await this.lockRequest(tx, organizationId, body.idempotencyKey)
      return this.recordIn(tx, organizationId, body, actor, null)
    })
    if (!recorded.replayed) this.auditRecorded(organizationId, recorded, body, actor)
    return this.get(organizationId, recorded.id)
  }

  // Voids one: the reversing entry is posted (dated like the original, or in the open period when the original's is closed) and
  // the transaction points at it. The reason is the memo of the reversal.
  async voidTransaction(
    organizationId: string,
    id: string,
    body: VoidTransactionBody,
    actor: Actor,
    granted: readonly Permission[]
  ): Promise<TransactionView> {
    const voided = await this.prisma.transaction(async tx =>
      this.voidIn(tx, organizationId, id, body.reason, actor, granted)
    )
    this.auditVoided(organizationId, id, voided.entryId, null, actor)
    return this.get(organizationId, id)
  }

  // Changes one: it is voided and the replacement registered in ONE transaction of the database, so either both happen or
  // neither does. The replacement keeps the kind: an expense is not turned into a transfer (the permission of the kind is
  // what let the person in), it is voided and the other registered.
  async replace(
    organizationId: string,
    id: string,
    body: ReplaceTransactionBody,
    actor: Actor,
    granted: readonly Permission[]
  ): Promise<TransactionView> {
    requireTransactionPermission(body.replacement.kind, granted)
    const result = await this.prisma.transaction(async tx => {
      await this.lockRequest(tx, organizationId, body.replacement.idempotencyKey)
      const earlier = await this.byClientKey(tx, organizationId, body.replacement.idempotencyKey)
      // A retry finds the replacement the first request made, and does not void anything again
      if (earlier !== null) {
        if (earlier.replacesTransactionId !== id) {
          throw resourceConflict('the key of the request belongs to another transaction', {
            conflict: FinanceConflicts.TRANSACTION_KEY_REUSED
          })
        }
        return {
          voided: null,
          recorded: await this.recordIn(tx, organizationId, body.replacement, actor, id)
        }
      }
      const voided = await this.voidIn(
        tx,
        organizationId,
        id,
        body.reason,
        actor,
        granted,
        body.replacement.kind
      )
      return {
        voided,
        recorded: await this.recordIn(tx, organizationId, body.replacement, actor, id)
      }
    })
    if (result.voided !== null) {
      this.auditVoided(organizationId, id, result.voided.entryId, result.recorded.id, actor)
    }
    if (!result.recorded.replayed) {
      this.auditRecorded(organizationId, result.recorded, body.replacement, actor)
    }
    return this.get(organizationId, result.recorded.id)
  }

  // Two requests with one key at once do not both pass: the second waits here until the first has committed, then finds it
  private async lockRequest(
    tx: PrismaTransaction,
    organizationId: string,
    clientKey: string
  ): Promise<void> {
    await lockScope(tx, `${organizationId}:transaction:${clientKey}`)
  }

  private byClientKey(
    tx: PrismaTransaction,
    organizationId: string,
    clientKey: string
  ): Promise<TransactionRow | null> {
    return tx.financeTransaction.findUnique({
      where: { organizationId_clientKey: { organizationId, clientKey } },
      select: TRANSACTION_SELECT
    })
  }

  private async row(
    db: Pick<PrismaTransaction, 'financeTransaction'>,
    organizationId: string,
    id: string
  ): Promise<TransactionRow> {
    const row = await db.financeTransaction.findFirst({
      where: { id, organizationId },
      select: TRANSACTION_SELECT
    })
    if (row === null) throw resourceNotFound('finance transaction')
    return row
  }

  private async recordIn(
    tx: PrismaTransaction,
    organizationId: string,
    body: RecordTransactionBody,
    actor: Actor,
    replaces: string | null
  ): Promise<Recorded> {
    const found = await this.byClientKey(tx, organizationId, body.idempotencyKey)
    if (found !== null) {
      if (!this.sameRequest(found, body, replaces)) {
        throw resourceConflict('the key of the request belongs to another transaction', {
          conflict: FinanceConflicts.TRANSACTION_KEY_REUSED
        })
      }
      return { id: found.id, replayed: true, entryNumber: null }
    }

    const settings = await tx.financeSettings.findUnique({
      where: { organizationId },
      select: { taxRounding: true }
    })
    if (settings === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)

    const { draft, facts, taxRateActive } = await this.draftOf(tx, organizationId, body)
    const taxCents = transactionTax(draft, settings.taxRounding as TaxRounding)
    const problems = [
      ...transactionProblems(draft, taxCents, accountId => facts.get(accountId)),
      ...(taxRateActive ? [] : [TransactionRule.TAX_RATE_INACTIVE]),
      ...(body.occurredOn > this.latestDay() ? [TransactionRule.DATE_IN_FUTURE] : [])
    ]
    if (problems.length > 0) throw invalidTransaction(problems)

    const id = randomUUID()
    const memo = draft.memo
    const posted = await this.ledger.post(
      {
        organizationId,
        entryDate: body.occurredOn,
        type: ENTRY_TYPE_OF_KIND[body.kind],
        sourceType: FinanceSourceType.FINANCE_TRANSACTION,
        sourceId: id,
        sourceDate: body.occurredOn,
        idempotencyKey: FinanceIdempotencyKey.TRANSACTION(id),
        memo,
        origin: EntryOrigin.USER,
        createdBy: actor.userId,
        lines: transactionLines(draft, taxCents)
      },
      tx
    )
    await tx.financeTransaction.create({
      data: {
        id,
        organizationId,
        storeId: draft.storeId,
        kind: body.kind,
        occurredOn: dayDate(body.occurredOn),
        amountCents: body.amountCents,
        fromAccountId: draft.fromAccountId,
        toAccountId: draft.toAccountId,
        categoryAccountId: draft.categoryAccountId,
        taxRateId: draft.taxRate?.id ?? null,
        // What the entry books AS tax: an expense whose tax is not creditable books it whole to its category, so the header says 0
        // (the journal and the header agree to the cent; the report of the base reads the amount)
        taxCents:
          draft.kind === FinanceTransactionKind.EXPENSE && !draft.taxCreditable ? 0 : taxCents,
        taxCreditable: draft.taxCreditable,
        documentNumber: body.documentNumber ?? null,
        memo,
        clientKey: body.idempotencyKey,
        entryId: posted.id,
        replacesTransactionId: replaces,
        createdBy: actor.userId
      }
    })
    return { id, replayed: false, entryNumber: posted.number }
  }

  // The latest accounting day a transaction may have: today (UTC) and the day of slack the person's clock may have over it
  private latestDay(): string {
    return dateToDay(new Date(Date.now() + FinanceLimits.TRANSACTION_FUTURE_DAYS * MS_PER_DAY))
  }

  // The request as the rules read it, with what it names looked up INSIDE the organization: an id of another organization is
  // an id that does not exist (404), never a row that is read
  private async draftOf(
    tx: PrismaTransaction,
    organizationId: string,
    body: RecordTransactionBody
  ): Promise<{
    draft: TransactionDraft
    facts: Map<string, TransactionAccount>
    taxRateActive: boolean
  }> {
    const ids = [body.fromAccountId, body.toAccountId, body.categoryAccountId].filter(
      (value): value is string => value !== undefined
    )
    const accounts = await tx.ledgerAccount.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true, type: true, cashKind: true }
    })
    const facts = new Map<string, TransactionAccount>(
      accounts.map(account => [
        account.id,
        {
          type: account.type as TransactionAccount['type'],
          cashKind: account.cashKind as TransactionAccount['cashKind']
        }
      ])
    )
    if (new Set(ids).size !== facts.size) throw resourceNotFound('ledger account')
    if (body.storeId !== undefined) {
      const store = await tx.store.findFirst({
        where: { id: body.storeId, organizationId },
        select: { id: true }
      })
      if (store === null) throw resourceNotFound('store')
    }
    let taxRate: TransactionTaxRate | null = null
    let taxRateActive = true
    if (body.taxRateId !== undefined) {
      const rate = await tx.taxRate.findFirst({
        where: { id: body.taxRateId, organizationId },
        select: {
          id: true,
          rateBps: true,
          outputAccountId: true,
          inputAccountId: true,
          active: true
        }
      })
      if (rate === null) throw resourceNotFound('tax rate')
      taxRate = rate
      taxRateActive = rate.active
    }
    const memo = body.memo?.trim() ?? ''
    return {
      draft: {
        kind: body.kind,
        amountCents: body.amountCents,
        fromAccountId: body.fromAccountId ?? null,
        toAccountId: body.toAccountId ?? null,
        categoryAccountId: body.categoryAccountId ?? null,
        taxRate,
        taxCreditable: body.taxCreditable,
        storeId: body.storeId ?? null,
        memo: memo.length === 0 ? null : memo
      },
      facts,
      taxRateActive
    }
  }

  // The same key with the same content is the same request; with another content it is a mistake of the client, never a
  // second transaction and never an overwrite
  private sameRequest(
    found: TransactionRow,
    body: RecordTransactionBody,
    replaces: string | null
  ): boolean {
    const memo = body.memo?.trim() ?? ''
    return (
      (found.kind as FinanceTransactionKind) === body.kind &&
      dateToDay(found.occurredOn) === body.occurredOn &&
      found.amountCents === body.amountCents &&
      found.fromAccountId === (body.fromAccountId ?? null) &&
      found.toAccountId === (body.toAccountId ?? null) &&
      found.categoryAccountId === (body.categoryAccountId ?? null) &&
      found.storeId === (body.storeId ?? null) &&
      found.taxRateId === (body.taxRateId ?? null) &&
      found.taxCreditable === body.taxCreditable &&
      found.documentNumber === (body.documentNumber ?? null) &&
      found.memo === (memo.length === 0 ? null : memo) &&
      found.replacesTransactionId === replaces
    )
  }

  private async voidIn(
    tx: PrismaTransaction,
    organizationId: string,
    id: string,
    reason: string,
    actor: Actor,
    granted: readonly Permission[],
    mustBeKind: FinanceTransactionKind | null = null
  ): Promise<{ entryId: string }> {
    const original = await this.row(tx, organizationId, id)
    requireTransactionPermission(original.kind as FinanceTransactionKind, granted)
    if (mustBeKind !== null && (original.kind as FinanceTransactionKind) !== mustBeKind) {
      throw resourceConflict('a change keeps the kind of the transaction', {
        conflict: FinanceConflicts.TRANSACTION_KIND_CHANGED
      })
    }
    if (original.voidedByEntryId !== null) {
      throw resourceConflict('the transaction was voided already', {
        conflict: FinanceConflicts.TRANSACTION_ALREADY_VOIDED
      })
    }
    // The reversal found under the entry is another request's (another person or another reason got the lock first): the transaction
    // was voided already, the typed answer of this route
    const reversal = await this.ledger
      .reverse(
        {
          organizationId,
          entryId: original.entryId,
          memo: reason,
          entryDate: null,
          createdBy: actor.userId
        },
        tx
      )
      .catch((error: unknown) => {
        if (
          error instanceof PlatformException &&
          error.code === ErrorCodes.FINANCE_ENTRY_ALREADY_REVERSED
        ) {
          throw resourceConflict('the transaction was voided already', {
            conflict: FinanceConflicts.TRANSACTION_ALREADY_VOIDED
          })
        }
        throw error
      })
    // The pointer is set once: a second request that got here after the first committed finds it set and answers it
    const pointed = await tx.financeTransaction.updateMany({
      where: { id, organizationId, voidedByEntryId: null },
      data: { voidedByEntryId: reversal.id }
    })
    if (pointed.count === 0) {
      throw resourceConflict('the transaction was voided already', {
        conflict: FinanceConflicts.TRANSACTION_ALREADY_VOIDED
      })
    }
    // The pointer was set by THIS request (a second one finds it set and is refused above), so this is the request that voided it
    return { entryId: reversal.id }
  }

  private auditVoided(
    organizationId: string,
    id: string,
    reversalEntryId: string,
    replacedBy: string | null,
    actor: Actor
  ): void {
    this.audit.log({
      action: AuditAction.FINANCE_TRANSACTION_VOIDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.TRANSACTION,
      resourceId: id,
      metadata: { reversalEntryId, ...(replacedBy === null ? {} : { replacedBy }) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private auditRecorded(
    organizationId: string,
    recorded: Recorded,
    body: RecordTransactionBody,
    actor: Actor
  ): void {
    this.audit.log({
      action: AuditAction.FINANCE_TRANSACTION_RECORDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.TRANSACTION,
      resourceId: recorded.id,
      metadata: {
        kind: body.kind,
        amountCents: body.amountCents,
        entryNumber: recorded.entryNumber?.toString() ?? null
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
