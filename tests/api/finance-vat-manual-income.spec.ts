import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  FinanceCountryCodes,
  FinanceTransactionKind,
  VatLineKind,
  VatSide
} from '@platform/core/domain'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ReportBody {
  rows: {
    month: string
    side: string
    kind: string
    rateBps: number | null
    baseCents: number | null
    taxCents: number
    documents: number
  }[]
  months: { month: string; outputTaxCents: number; inputTaxCents: number; balanceCents: number }[]
}
interface TransactionBody {
  id: string
}

const OK = 200
const CREATED = 201
const BANK = '111001'
const OTHER_INCOME = '4105'
const DAY_MS = 86_400_000
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)
const TODAY = isoDay(0)
const FROM = isoDay(-40)

// HC-002 (TDD_18 §7): the output side of the VAT report holds the tax of the incomes registered by hand (E12) too, by rate, and a
// voided income takes its tax back out. Without it the report says less than the VAT_OUTPUT account of the books.
describe('The VAT report and the incomes registered by hand (HC-002)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let vatId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
    vatId = (
      await owner.taxRate.findFirstOrThrow({ where: { organizationId: ctx.orgA.id, code: 'IVA' } })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const income = (extra: Record<string, unknown> = {}) => ({
    idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
    kind: FinanceTransactionKind.INCOME,
    occurredOn: TODAY,
    amountCents: 11_300,
    toAccountId: accounts[BANK],
    categoryAccountId: accounts[OTHER_INCOME],
    ...extra
  })
  async function registered(body: Record<string, unknown>): Promise<TransactionBody> {
    const response = await asAdminA().post(ApiRoutes.finance.transactions.record).send(body)
    expect(response.status).toBe(CREATED)
    return response.body as TransactionBody
  }
  async function accountOf(organizationId: string, code: string): Promise<string> {
    return (await owner.ledgerAccount.findFirstOrThrow({ where: { organizationId, code } })).id
  }
  async function report(organizationId = ctx.orgA.id): Promise<ReportBody> {
    const actor = organizationId === ctx.orgA.id ? asAdminA() : api(app, ctx.adminB, ctx.storeB)
    const response = await actor.get(`${ApiRoutes.finance.reports.vat}?from=${FROM}&to=${TODAY}`)
    expect(response.status).toBe(OK)
    return response.body as ReportBody
  }
  const output = (body: ReportBody) =>
    body.rows.filter(row => row.side === (VatSide.OUTPUT as string))
  const outputTax = (body: ReportBody): number =>
    output(body).reduce((sum, row) => sum + row.taxCents, 0)
  async function vatOutputOfBooks(organizationId = ctx.orgA.id): Promise<number> {
    const mapping = await owner.accountRoleMapping.findFirstOrThrow({
      where: { organizationId, role: AccountRole.VAT_OUTPUT },
      select: { accountId: true }
    })
    const sum = await owner.journalLine.aggregate({
      where: { organizationId, accountId: mapping.accountId },
      _sum: { creditCents: true, debitCents: true }
    })
    return (sum._sum.creditCents ?? 0) - (sum._sum.debitCents ?? 0)
  }

  const taxedRows = (body: ReportBody, rateBps: number) =>
    output(body).filter(row => row.rateBps === rateBps)
  const sum = (body: ReportBody, rateBps: number, field: 'baseCents' | 'taxCents' | 'documents') =>
    taxedRows(body, rateBps).reduce((total, row) => total + (row[field] ?? 0), 0)

  it('counts the tax of an income registered by hand, by rate, with its base, as the books do', async () => {
    const before = await report()
    await registered(income({ taxRateId: vatId }))
    await registered(income({ taxRateId: vatId, amountCents: 5650 }))
    const body = await report()
    expect(output(body).every(row => row.kind === (VatLineKind.TAXED as string))).toBe(true)
    expect(sum(body, 1300, 'baseCents') - sum(before, 1300, 'baseCents')).toBe(15_000)
    expect(sum(body, 1300, 'taxCents') - sum(before, 1300, 'taxCents')).toBe(1950)
    expect(sum(body, 1300, 'documents') - sum(before, 1300, 'documents')).toBe(2)
    expect(outputTax(body)).toBe(await vatOutputOfBooks())
    // The balance of the months is what the books owe
    expect(body.months.reduce((total, month) => total + month.balanceCents, 0)).toBe(
      outputTax(body)
    )
  })

  it('takes a voided income back out with no row of zeros, and leaves an income with no tax out', async () => {
    const before = await report()
    const taxed = await registered(income({ taxRateId: vatId, amountCents: 22_600 }))
    await registered(income())
    const during = await report()
    expect(sum(during, 1300, 'taxCents') - sum(before, 1300, 'taxCents')).toBe(2600)
    expect(sum(during, 1300, 'baseCents') - sum(before, 1300, 'baseCents')).toBe(20_000)
    const voided = await asAdminA()
      .post(ApiRoutes.finance.transactions.void(taxed.id))
      .send({ reason: 'Wrong customer' })
    expect(voided.status).toBe(CREATED)
    const after = await report()
    expect(sum(after, 1300, 'taxCents')).toBe(sum(before, 1300, 'taxCents'))
    expect(sum(after, 1300, 'baseCents')).toBe(sum(before, 1300, 'baseCents'))
    expect(sum(after, 1300, 'documents')).toBe(sum(before, 1300, 'documents'))
    expect(output(after).some(row => row.taxCents === 0 && row.baseCents === 0)).toBe(false)
    expect(outputTax(after)).toBe(await vatOutputOfBooks())
  })

  it('gives the same rows in the CSV', async () => {
    await registered(income({ taxRateId: vatId, amountCents: 11_300 }))
    const response = await asAdminA().get(
      `${ApiRoutes.finance.reports.vatCsv}?from=${FROM}&to=${TODAY}`
    )
    expect(response.status).toBe(OK)
    const json = await report()
    const lines = response.text.replace('\uFEFF', '').trim().split('\r\n')
    const outputLines = lines.filter(line => line.split(',')[1] === (VatSide.OUTPUT as string))
    expect(outputLines.length).toBe(output(json).length)
    expect(outputLines.length).toBeGreaterThan(0)
  })

  it('never reads the incomes of another organization, in either direction', async () => {
    const mine = outputTax(await report())
    expect(outputTax(await report(ctx.orgB.id))).toBe(0)
    const response = await api(app, ctx.adminB, ctx.storeB)
      .post(ApiRoutes.finance.transactions.record)
      .send({
        ...income(),
        toAccountId: await accountOf(ctx.orgB.id, BANK),
        categoryAccountId: await accountOf(ctx.orgB.id, OTHER_INCOME),
        taxRateId: (
          await owner.taxRate.findFirstOrThrow({
            where: { organizationId: ctx.orgB.id, code: 'IVA' }
          })
        ).id
      })
    expect(response.status).toBe(CREATED)
    expect(outputTax(await report(ctx.orgB.id))).toBe(1300)
    expect(outputTax(await report())).toBe(mine)
  })
})
