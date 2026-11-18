import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountType,
  CashKind,
  EntryOrigin,
  JournalEntryType,
  NormalSide,
  PeriodStatus
} from '@platform/core/domain'
import { normalSideOf } from '@platform/core/finance'
import { hashEntry } from '@platform/core/finance-hash'

// The books of a test organization, written as the owner of the database. The posting service of Step 4B.2 (PR b) is the
// only writer of the ledger in the application; these builders are the test's own hands, so they take the same lock and
// the same hash and let a test override what the service would never get wrong (a number, a hash, a total).

export const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`)

export interface FinanceFixture {
  organizationId: string
  periodId: string
  accounts: {
    cash: string
    bank: string
    revenue: string
    expense: string
    header: string
    inactive: string
    liability: string
  }
}

export async function createFinanceFixture(
  owner: OwnerClient,
  organizationId: string,
  options: { accountingStartDate?: string; periodYear?: number; periodMonth?: number } = {}
): Promise<FinanceFixture> {
  const { accountingStartDate = '2026-01-01', periodYear = 2026, periodMonth = 11 } = options
  await owner.financeSettings.create({
    data: { organizationId, countryCode: 'SV', accountingStartDate: day(accountingStartDate) }
  })
  const periodId = await createPeriod(owner, organizationId, periodYear, periodMonth)
  const account = async (
    code: string,
    name: string,
    type: AccountType,
    extra: { isPostable?: boolean; active?: boolean; cashKind?: CashKind } = {}
  ): Promise<string> =>
    (
      await owner.ledgerAccount.create({
        data: { organizationId, code, name, type, normalSide: normalSideOf(type), ...extra },
        select: { id: true }
      })
    ).id
  // The books of an organization always have a default tax rate (the setup seeds one): a taxed product with none cannot be sold
  const outputAccountId = await account('2201', 'IVA debito', AccountType.LIABILITY)
  const inputAccountId = await account('1401', 'IVA credito', AccountType.ASSET)
  await owner.taxRate.create({
    data: {
      organizationId,
      code: 'IVA',
      name: 'IVA 13 %',
      rateBps: 1300,
      outputAccountId,
      inputAccountId,
      isDefault: true
    }
  })
  return {
    organizationId,
    periodId,
    accounts: {
      cash: await account('1101', 'Caja', AccountType.ASSET, { cashKind: CashKind.CASH }),
      bank: await account('1110', 'Banco', AccountType.ASSET, { cashKind: CashKind.BANK }),
      revenue: await account('4101', 'Ventas', AccountType.INCOME),
      expense: await account('6101', 'Fletes', AccountType.EXPENSE),
      header: await account('1', 'Activo', AccountType.ASSET, { isPostable: false }),
      inactive: await account('6199', 'Cerrada', AccountType.EXPENSE, { active: false }),
      liability: await account('2101', 'Proveedores', AccountType.LIABILITY)
    }
  }
}

export async function createPeriod(
  owner: OwnerClient,
  organizationId: string,
  year: number,
  month: number,
  status: PeriodStatus = PeriodStatus.OPEN
): Promise<string> {
  const startsOn = new Date(Date.UTC(year, month - 1, 1))
  const endsOn = new Date(Date.UTC(year, month, 0))
  const closed = status === PeriodStatus.CLOSED
  return (
    await owner.fiscalPeriod.create({
      data: {
        organizationId,
        year,
        month,
        startsOn,
        endsOn,
        status,
        ...(closed ? { closedAt: new Date(), closedBy: 'test-closer' } : {})
      },
      select: { id: true }
    })
  ).id
}

// What a post returns: the entry as stored, with its lines in order
export type PostedEntry = Awaited<ReturnType<OwnerClient['journalEntry']['findFirstOrThrow']>> & {
  lines: Awaited<ReturnType<OwnerClient['journalLine']['findMany']>>
}

export interface TestLine {
  accountId: string
  debitCents?: number
  creditCents?: number
  storeId?: string | null
  partyType?: string | null
  partyId?: string | null
  taxRateId?: string | null
}

export interface TestEntry {
  organizationId: string
  periodId: string
  entryDate?: string
  type?: JournalEntryType
  idempotencyKey?: string
  memo?: string | null
  origin?: EntryOrigin
  createdBy?: string | null
  sourceType?: string | null
  sourceId?: string | null
  reversesEntryId?: string | null
  lines: TestLine[]
  // What the service would never get wrong, for the tests of the net under it
  override?: { number?: bigint; prevHash?: string | null; hash?: string; totalCents?: number }
}

// Posts one entry the way the service does: the lock on the settings, the next number, the head of the chain, the hash, the
// entry with its lines, all in one transaction. Returns the entry.
export async function postTestEntry(owner: OwnerClient, entry: TestEntry): Promise<PostedEntry> {
  const entryDate = entry.entryDate ?? '2026-11-10'
  const origin = entry.origin ?? EntryOrigin.SYSTEM
  const createdBy =
    entry.createdBy === undefined
      ? origin === EntryOrigin.USER
        ? 'test-user'
        : null
      : entry.createdBy
  const type = entry.type ?? JournalEntryType.EXPENSE
  const lines = entry.lines.map((line, index) => ({
    accountId: line.accountId,
    debitCents: line.debitCents ?? 0,
    creditCents: line.creditCents ?? 0,
    storeId: line.storeId ?? null,
    partyType: line.partyType ?? null,
    partyId: line.partyId ?? null,
    taxRateId: line.taxRateId ?? null,
    memo: null,
    lineNo: index + 1
  }))
  const idempotencyKey = entry.idempotencyKey ?? `test:${randomUUID()}`
  // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
  return owner.$transaction(
    async tx => {
      const [head] = await tx.$queryRaw<{ next: bigint; hash: string | null }[]>`
      SELECT next_entry_number AS next, last_entry_hash AS hash FROM finance_settings
      WHERE organization_id = ${entry.organizationId} FOR UPDATE`
      if (head === undefined) throw new Error('no finance settings for the organization')
      const number = entry.override?.number ?? head.next
      const prevHash = entry.override?.prevHash === undefined ? head.hash : entry.override.prevHash
      const summed = lines.reduce((sum, line) => sum + line.debitCents, 0)
      const totalCents = entry.override?.totalCents ?? Math.max(summed, 1)
      const hash =
        entry.override?.hash ??
        hashEntry({
          number,
          entryDate,
          periodId: entry.periodId,
          totalCents,
          currency: 'USD',
          type,
          sourceType: entry.sourceType ?? null,
          sourceId: entry.sourceId ?? null,
          sourceDate: null,
          reversesEntryId: entry.reversesEntryId ?? null,
          idempotencyKey,
          memo: entry.memo ?? null,
          origin,
          createdBy,
          prevHash,
          lines
        })
      const created = await tx.journalEntry.create({
        data: {
          organizationId: entry.organizationId,
          number,
          entryDate: day(entryDate),
          periodId: entry.periodId,
          type,
          sourceType: entry.sourceType ?? null,
          sourceId: entry.sourceId ?? null,
          reversesEntryId: entry.reversesEntryId ?? null,
          idempotencyKey,
          memo: entry.memo ?? null,
          totalCents,
          createdBy,
          origin,
          prevHash,
          hash
        }
      })
      // The lines name their organization themselves (a composite key: a nested create cannot say it)
      await tx.journalLine.createMany({
        data: lines.map(line => ({
          ...line,
          entryId: created.id,
          organizationId: entry.organizationId
        }))
      })
      const stored = await tx.journalLine.findMany({
        where: { entryId: created.id },
        orderBy: { lineNo: 'asc' }
      })
      return { ...created, lines: stored }
    },
    { timeout: 30_000, maxWait: 30_000 }
  )
}

// The two-line entry most tests need: debit one account and credit another for the same amount
export const simpleEntry = (
  fixture: FinanceFixture,
  cents = 1000,
  extra: Partial<TestEntry> = {}
): TestEntry => ({
  organizationId: fixture.organizationId,
  periodId: fixture.periodId,
  lines: [
    { accountId: fixture.accounts.expense, debitCents: cents },
    { accountId: fixture.accounts.cash, creditCents: cents }
  ],
  ...extra
})

export { NormalSide }

// The books of the organizations of a run, removed. The journal is append-only for everyone, the owner included, so the
// triggers are switched off inside one transaction, the rows go, and they are switched on again before it commits.
export async function purgeFinance(owner: OwnerClient, organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return
  const where = { organizationId: { in: organizationIds } }
  // Only a run that wrote books pays for the switch of the triggers: one query says whether it did
  const [found] = await owner.$queryRaw<{ touched: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM finance_settings WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM ledger_accounts WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM fiscal_periods WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM payment_method_accounts WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM tax_rates WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM finance_transactions WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM suppliers WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM purchase_orders WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM fiscal_documents WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM fiscal_issuers WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM fiscal_sequences WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM fiscal_contingencies WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM finance_chain_incidents WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM finance_book_layouts WHERE organization_id = ANY(${organizationIds}))
      OR EXISTS (SELECT 1 FROM finance_book_snapshots WHERE organization_id = ANY(${organizationIds}))
    ) AS touched`
  const touched = found?.touched === true
  if (!touched) return
  // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
  await owner.$transaction(async tx => {
    // The triggers of the tables that refuse a delete are off for the length of this transaction, and on again before it
    // commits (an error rolls the whole transaction back, the switch included)
    const guarded = [
      'finance_book_snapshots',
      'finance_book_layouts',
      'fiscal_documents',
      'fiscal_contingencies',
      'fiscal_sequences',
      'reconciliation_matches',
      'bank_statement_lines',
      'bank_statement_imports',
      'finance_transactions',
      'supplier_payment_returns',
      'supplier_payments',
      'purchase_receipts',
      'purchase_receipt_lines',
      'journal_lines',
      'journal_entries',
      'fiscal_periods',
      'ledger_accounts'
    ]
    for (const table of guarded)
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
    // The purchases name the entries, the accounts, the stores and the products: they go first (a payment names a bill, a bill its
    // order and its supplier). The lines of an order go with it (cascade)
    // The evidence of a fiscal document names it (and restricts its deletion): the files go first. Only the trigger that keeps evidence
    // for ever is off, for these statements alone; the other triggers of `media` stay on
    await tx.$executeRawUnsafe('ALTER TABLE media DISABLE TRIGGER trg_media_fiscal_evidence_keeps')
    await tx.media.deleteMany({
      where: { purpose: 'fiscal_evidence', store: { organizationId: { in: organizationIds } } }
    })
    await tx.$executeRawUnsafe('ALTER TABLE media ENABLE TRIGGER trg_media_fiscal_evidence_keeps')
    // A fiscal document names its order, its store and the sale entry: it goes before all of them
    // The frozen books and the layouts of the legal books name the organization and the period: they go before the periods
    await tx.financeBookSnapshot.deleteMany({ where })
    await tx.financeBookLayout.deleteMany({ where })
    await tx.fiscalDocument.deleteMany({ where })
    // A contingency is named by its documents: it goes after them
    await tx.fiscalContingency.deleteMany({ where })
    await tx.fiscalSequence.deleteMany({ where })
    await tx.fiscalIssuer.deleteMany({ where })
    await tx.supplierPaymentReturn.deleteMany({ where })
    await tx.supplierPayment.deleteMany({ where })
    await tx.purchaseReceiptLine.deleteMany({ where })
    await tx.purchaseReceipt.deleteMany({ where })
    await tx.purchaseOrderLine.deleteMany({ where })
    await tx.purchaseOrder.deleteMany({ where })
    await tx.supplier.deleteMany({ where })
    // The reconciliation names journal lines and accounts: its decisions go first, then the lines, the imports and the profiles
    await tx.reconciliationMatch.deleteMany({ where })
    await tx.bankStatementLine.deleteMany({ where })
    await tx.bankStatementImport.deleteMany({ where })
    await tx.bankImportProfile.deleteMany({ where })
    // A transaction names its entry and the one it replaced: the links are cut first, then the rows go before the journal
    await tx.financeTransaction.updateMany({
      where,
      data: { replacesTransactionId: null, voidedByEntryId: null, documentMediaId: null }
    })
    // A receipt names its transaction (and restricts its deletion): the link is cut, the file stays a file of its store. The order
    // matters: the triggers of `media` stay on, and the one that keeps a receipt's parent lets go only once no transaction points at it
    await tx.media.updateMany({
      where: {
        financeTransactionId: { not: null },
        store: { organizationId: { in: organizationIds } }
      },
      data: { financeTransactionId: null }
    })
    await tx.financeTransaction.deleteMany({ where })
    await tx.journalLine.deleteMany({ where })
    await tx.journalEntry.deleteMany({ where })
    await tx.accountPeriodBalance.deleteMany({ where })
    await tx.financePostingFailure.deleteMany({ where })
    await tx.financeChainIncident.deleteMany({ where })
    await tx.accountRoleMapping.deleteMany({ where })
    await tx.paymentMethodAccount.deleteMany({ where })
    // A product names its tax rate and the rate names accounts: the products let go first, then the rates, then the accounts
    await tx.product.updateMany({
      where: { store: { organizationId: { in: organizationIds } }, taxRateId: { not: null } },
      data: { taxRateId: null }
    })
    await tx.taxRate.deleteMany({ where })
    await tx.financeSettings.deleteMany({ where })
    // The tree of accounts: a parent restricts its children, so the links are cut first (the guard of the chart is off, so the
    // system accounts go too)
    await tx.ledgerAccount.updateMany({ where, data: { parentId: null } })
    await tx.ledgerAccount.deleteMany({ where })
    await tx.fiscalPeriod.deleteMany({ where })
    for (const table of guarded)
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
  })
}

// What someone with the owner role of the database could do: edit the ledger with its triggers off, inside one transaction. The chain must
// see it anyway (TDD_18 §11); the triggers are on again before it commits
export async function tamperWithLedger(
  owner: OwnerClient,
  statements: readonly string[]
): Promise<void> {
  const tables = ['journal_entries', 'journal_lines', 'finance_settings']
  // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
  await owner.$transaction(async tx => {
    for (const table of tables)
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
    for (const statement of statements) await tx.$executeRawUnsafe(statement)
    for (const table of tables)
      await tx.$executeRawUnsafe(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
  })
}
