import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  AgingKind,
  FinanceCountryCodes,
  FinanceReport,
  JournalEntryType,
  PartyType,
  StatementWarning
} from '@platform/core/domain'

import { createPeriod, postTestEntry } from '../builders/finance'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface Section {
  rows: { code: string; balanceCents: string }[]
  totalCents: string
}
interface IncomeBody {
  income: Section
  costOfSales: Section
  expenses: Section
  grossMarginCents: string
  netResultCents: string
  warnings: string[]
}
interface SheetBody {
  assets: Section
  liabilities: Section
  equity: Section
  resultCents: string
  equityWithResultCents: string
  balanced: boolean
}
interface FlowBody {
  sources: { source: string; inflowCents: string; outflowCents: string }[]
  inflowCents: string
  outflowCents: string
  openingCents: string
  closingCents: string
  closes: boolean
  warnings: string[]
}
interface AgingBody {
  rows: { partyName: string | null; bucketsCents: string[]; totalCents: string }[]
  bucketsCents: string[]
  totalCents: string
  missingRoles: string[]
  warnings: string[]
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403

const START = '2026-01-01'
const CASH = '1101'
const SALES = '4101'
const COST = '5101'
const INVENTORY = '1301'
const RENT = '6105'
const PAYABLE = '2101'
const EQUITY = '3103'

describe('The statements and the lists with age', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accountsA: Record<string, string> = {}
  let accountsB: Record<string, string> = {}
  let supplierId = ''

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const asRole = async (
    name: string,
    permissions: readonly (typeof Permissions)[keyof typeof Permissions][]
  ) =>
    api(
      app,
      await actorWithPermissions(owner, app, {
        prefix,
        name,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions
      }),
      ctx.storeA
    )

  async function accountIds(organizationId: string): Promise<Record<string, string>> {
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId },
      select: { id: true, code: true }
    })
    return Object.fromEntries(rows.map(row => [row.code, row.id]))
  }
  async function manual(
    agent: () => ReturnType<typeof asAdminA>,
    accounts: Record<string, string>,
    entryDate: string,
    debit: string,
    credit: string,
    cents: number
  ): Promise<void> {
    const response = await agent()
      .post(ApiRoutes.finance.entries.manual)
      .send({
        idempotencyKey: `k-${randomUUID()}`,
        entryDate,
        type: JournalEntryType.MANUAL,
        memo: 'Entry of the suite',
        lines: [
          { accountId: accounts[debit], debitCents: cents },
          { accountId: accounts[credit], creditCents: cents }
        ]
      })
    expect(response.status).toBe(CREATED)
  }
  async function withParty(
    entryDate: string,
    debit: string,
    credit: string,
    cents: number,
    partyOn: 'debit' | 'credit'
  ): Promise<void> {
    const year = Number(entryDate.slice(0, 4))
    const month = Number(entryDate.slice(5, 7))
    // A month nobody posted into through the api has no period row yet: the posting service makes it, the builder does the same
    const existing = await owner.fiscalPeriod.findFirst({
      where: { organizationId: ctx.orgA.id, year, month },
      select: { id: true }
    })
    const periodId = existing?.id ?? (await createPeriod(owner, ctx.orgA.id, year, month))
    const party = { partyType: PartyType.SUPPLIER, partyId: supplierId }
    await postTestEntry(owner, {
      organizationId: ctx.orgA.id,
      periodId,
      entryDate,
      type: JournalEntryType.MANUAL,
      lines: [
        {
          accountId: accountsA[debit] ?? '',
          debitCents: cents,
          ...(partyOn === 'debit' ? party : {})
        },
        {
          accountId: accountsA[credit] ?? '',
          creditCents: cents,
          ...(partyOn === 'credit' ? party : {})
        }
      ]
    })
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const agent of [asAdminA, asAdminB]) {
      const response = await agent()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
      expect(response.status).toBe(CREATED)
    }
    accountsA = await accountIds(ctx.orgA.id)
    accountsB = await accountIds(ctx.orgB.id)
    supplierId = (
      await owner.supplier.create({
        data: { organizationId: ctx.orgA.id, name: 'Proveedor del suite' },
        select: { id: true }
      })
    ).id
    // January: a sale of 10 000, its cost 6 000, a rent of 1 500, and a purchase on credit of 7 000 (the first of 4 000, with a supplier)
    await manual(asAdminA, accountsA, '2026-01-10', CASH, SALES, 10_000)
    await manual(asAdminA, accountsA, '2026-01-12', COST, INVENTORY, 6_000)
    await manual(asAdminA, accountsA, '2026-01-20', RENT, CASH, 1_500)
    await withParty('2026-01-05', INVENTORY, PAYABLE, 4_000, 'credit')
    // February: the capital of the owner, and the second purchase on credit (3 000)
    await manual(asAdminA, accountsA, '2026-02-02', CASH, EQUITY, 5_000)
    await withParty('2026-02-20', INVENTORY, PAYABLE, 3_000, 'credit')
    // March: a payment of 4 500 to the supplier: it settles January and 500 of February
    await withParty('2026-03-01', PAYABLE, CASH, 4_500, 'debit')
    // The other organization has books of its own that must never show up in A's statements
    await manual(asAdminB, accountsB, '2026-01-10', RENT, CASH, 777)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  describe('the income statement', () => {
    it('adds income, cost of sales and expenses from the lines, in whole cents', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-01-01', to: '2026-01-31' })

      expect(response.status).toBe(OK)
      const body = response.body as IncomeBody
      expect(body.income.totalCents).toBe('10000')
      expect(body.costOfSales.totalCents).toBe('6000')
      expect(body.grossMarginCents).toBe('4000')
      expect(body.expenses.totalCents).toBe('1500')
      expect(body.netResultCents).toBe('2500')
      expect(body.warnings).toEqual([])
    })

    it('does not include another organization nor a day out of the range', async () => {
      const own = (await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-02-01', to: '2026-03-31' })) as { body: IncomeBody }
      const other = (await asAdminB()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-01-01', to: '2026-03-31' })) as { body: IncomeBody }

      expect(own.body.expenses.totalCents).toBe('0')
      expect(own.body.warnings).toEqual([
        StatementWarning.NO_INCOME,
        StatementWarning.NO_COST_OF_SALES
      ])
      expect(other.body.expenses.totalCents).toBe('777')
      // Nor the chart of the other organization: a name only B has is in no statement of A
      await owner.ledgerAccount.update({
        where: { id: accountsB[RENT] ?? '' },
        data: { name: 'Private account of the other organization' }
      })
      const sheet = await asAdminA()
        .get(ApiRoutes.finance.reports.balanceSheet)
        .query({ asOf: '2026-03-31' })
      const statement = await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-01-01', to: '2026-03-31' })
      expect(JSON.stringify([sheet.body, statement.body])).not.toContain('Private account')
      expect(other.body.income.totalCents).toBe('0')
    })

    it('narrows to a store that has no lines of its own', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-01-01', to: '2026-01-31', storeId: ctx.storeA.id })

      expect((response.body as IncomeBody).income.totalCents).toBe('0')
    })

    it('refuses a range that is upside down or a date that does not exist', async () => {
      const backwards = await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-02-01', to: '2026-01-01' })
      const invented = await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatement)
        .query({ from: '2026-02-30', to: '2026-03-01' })

      expect(backwards.status).toBe(BAD_REQUEST)
      expect(invented.status).toBe(BAD_REQUEST)
    })
  })

  describe('the balance sheet', () => {
    it('balances with the result of the periods inside equity', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.balanceSheet)
        .query({ asOf: '2026-03-31' })

      expect(response.status).toBe(OK)
      const body = response.body as SheetBody
      expect(body.assets.totalCents).toBe('10000')
      expect(body.liabilities.totalCents).toBe('2500')
      expect(body.equity.totalCents).toBe('5000')
      expect(body.resultCents).toBe('2500')
      expect(body.equityWithResultCents).toBe('7500')
      expect(body.balanced).toBe(true)
    })

    it('reads the books as they were on an earlier day', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.balanceSheet)
        .query({ asOf: '2026-01-31' })

      const body = response.body as SheetBody
      // Cash 8 500 and inventory 4 000 - 6 000 = -2 000, against a payable of 4 000 and a result of 2 500
      expect(body.assets.totalCents).toBe('6500')
      expect(body.liabilities.totalCents).toBe('4000')
      expect(body.balanced).toBe(true)
    })
  })

  describe('the cash flow', () => {
    it('shows what moved the cash accounts by source and closes against the balances', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.cashFlow)
        .query({ from: '2026-01-01', to: '2026-03-31' })

      const body = response.body as FlowBody
      expect(body.inflowCents).toBe('15000')
      expect(body.outflowCents).toBe('6000')
      expect(body.openingCents).toBe('0')
      expect(body.closingCents).toBe('9000')
      expect(body.closes).toBe(true)
      expect(body.sources.map(row => row.source)).toEqual(['manual'])
    })

    it('opens a later range with what the range before it left', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.cashFlow)
        .query({ from: '2026-02-01', to: '2026-03-31' })

      const body = response.body as FlowBody
      expect(body.openingCents).toBe('8500')
      expect(body.closingCents).toBe('9000')
      expect(body.closes).toBe(true)
    })
  })

  describe('payables and receivables with age', () => {
    it('settles the oldest first and puts what is left in the bucket of its age', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.aging)
        .query({ kind: AgingKind.PAYABLES, asOf: '2026-04-30' })

      expect(response.status).toBe(OK)
      const body = response.body as AgingBody
      expect(body.rows).toHaveLength(1)
      expect(body.rows[0]?.partyName).toBe('Proveedor del suite')
      // 2 500 of the purchase of 20 February, 69 days old
      expect(body.rows[0]?.bucketsCents).toEqual(['0', '0', '2500', '0'])
      expect(body.totalCents).toBe('2500')
      expect(body.missingRoles).toEqual([])
    })

    it('says so when an account role of the list is not mapped, instead of choosing one', async () => {
      await owner.accountRoleMapping.deleteMany({
        where: { organizationId: ctx.orgB.id, role: AccountRole.PAYABLE_CARRIERS }
      })

      const response = await asAdminB()
        .get(ApiRoutes.finance.reports.aging)
        .query({ kind: AgingKind.PAYABLES, asOf: '2026-04-30' })

      const body = response.body as AgingBody
      expect(body.missingRoles).toEqual([AccountRole.PAYABLE_CARRIERS])
      expect(body.warnings).toContain(StatementWarning.ROLE_NOT_MAPPED)
    })

    it('has nothing to age for the receivables of carriers here, and sees no other organization', async () => {
      const own = await asAdminA()
        .get(ApiRoutes.finance.reports.aging)
        .query({ kind: AgingKind.RECEIVABLES, asOf: '2026-04-30' })
      const other = await asAdminB()
        .get(ApiRoutes.finance.reports.aging)
        .query({ kind: AgingKind.PAYABLES, asOf: '2026-04-30' })

      expect((own.body as AgingBody).rows).toEqual([])
      expect((other.body as AgingBody).rows).toEqual([])
    })

    it('refuses a kind that is not one', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.aging)
        .query({ kind: 'everything', asOf: '2026-04-30' })

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('the files', () => {
    it('writes a text that starts like a formula as text, and leaves an audit row', async () => {
      await owner.ledgerAccount.update({
        where: { id: accountsA[RENT] ?? '' },
        data: { name: '=HYPERLINK("http://example.test")' }
      })

      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.incomeStatementCsv)
        .query({ from: '2026-01-01', to: '2026-01-31' })

      expect(response.status).toBe(OK)
      expect(response.headers['content-type']).toContain('text/csv')
      expect(response.headers['cache-control']).toBe('no-store')
      const text = response.text.replace(/^\uFEFF/, '')
      expect(text).toContain(`"'=HYPERLINK(""http://example.test"")"`)
      expect(text).not.toMatch(/(^|,)=HYPERLINK/m)
      expect(text).toContain('gross_margin')
      const audit = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_EXPORTED
      })
      expect(audit.map(row => (row.metadata as { report?: string } | null)?.report)).toContain(
        FinanceReport.INCOME_STATEMENT
      )
    })

    it('has a file for each of the other reports', async () => {
      for (const [route, query] of [
        [ApiRoutes.finance.reports.balanceSheetCsv, { asOf: '2026-03-31' }],
        [ApiRoutes.finance.reports.cashFlowCsv, { from: '2026-01-01', to: '2026-03-31' }],
        [ApiRoutes.finance.reports.agingCsv, { kind: AgingKind.PAYABLES, asOf: '2026-04-30' }]
      ] as const) {
        const response = await asAdminA().get(route).query(query)
        expect(response.status).toBe(OK)
        expect(response.headers['content-disposition']).toContain('attachment')
      }
    })
  })

  describe('who may read them', () => {
    it('needs finance:view_reports to read, and finance:export besides for a file', async () => {
      const viewer = await asRole('reports-viewer', [Permissions.FINANCE_VIEW_REPORTS])
      const onlyView = await asRole('only-view', [Permissions.FINANCE_VIEW])

      const read = await viewer
        .get(ApiRoutes.finance.reports.balanceSheet)
        .query({ asOf: '2026-03-31' })
      const file = await viewer
        .get(ApiRoutes.finance.reports.balanceSheetCsv)
        .query({ asOf: '2026-03-31' })
      const refused = await onlyView
        .get(ApiRoutes.finance.reports.balanceSheet)
        .query({ asOf: '2026-03-31' })

      expect(read.status).toBe(OK)
      expect(file.status).toBe(FORBIDDEN)
      expect(refused.status).toBe(FORBIDDEN)
    })
  })
})
