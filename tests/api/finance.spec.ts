import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  FinanceConflicts,
  FinanceCountryCodes,
  JournalEntryType,
  PaymentMethod,
  PeriodStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { financeTemplateFor } from '@platform/core/finance'
import { verifyChain } from '@platform/core/finance-hash'

import { day } from '../builders/finance'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface AccountBody {
  id: string
  code: string
  name: string
  type: string
  parentId: string | null
  isPostable: boolean
  cashKind: string | null
  isSystem: boolean
  active: boolean
}
interface EntryBody {
  id: string
  number: string
  entryDate: string
  type: string
  memo: string | null
  totalCents: number
  createdBy: string | null
  origin: string
  reversesEntryId: string | null
  reversedByEntryId: string | null
  prevHash: string | null
  hash: string
  lines: {
    lineNo: number
    accountId: string
    storeId: string | null
    debitCents: number
    creditCents: number
  }[]
}
interface BalanceBody {
  data: { accountId: string; debitCents: string; creditCents: string; balanceCents: string }[]
}

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const START = '2026-01-01'
const DATE = '2026-11-10'

describe('The books of an organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    // Organization A is set up through the api, as a person would; organization B stays untouched for the setup cases
    const response = await asAdminA()
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
    expect(response.status).toBe(CREATED)
    accounts = await accountIds(ctx.orgA.id)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const key = (): string => `k-${randomUUID()}`
  // The audit write is after the answer: give a wrong second record the time to show before a test says there is only one
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 400))
  async function auditCount(
    found: { action: string; resourceId: string | null }[]
  ): Promise<number> {
    const first = found[0]
    if (first === undefined) return 0
    return owner.auditLog.count({
      where: { organizationId: ctx.orgA.id, action: first.action, resourceId: first.resourceId }
    })
  }

  async function accountIds(organizationId: string): Promise<Record<string, string>> {
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId },
      select: { id: true, code: true }
    })
    return Object.fromEntries(rows.map(row => [row.code, row.id]))
  }
  // The accounts of the starter chart used below: cash and bank take entries, 6104 and 6105 are expenses no role points at
  const CASH = '1101'
  const BANK = '111001'
  const MARKETING = '6104'
  const RENT = '6105'

  const entryBody = (
    debit: string,
    credit: string,
    cents: number,
    extra: Record<string, unknown> = {}
  ) => ({
    idempotencyKey: key(),
    entryDate: DATE,
    type: JournalEntryType.MANUAL,
    memo: 'Adjustment of the suite',
    lines: [
      { accountId: accounts[debit], debitCents: cents },
      { accountId: accounts[credit], creditCents: cents }
    ],
    ...extra
  })
  async function postEntry(body: Record<string, unknown>): Promise<EntryBody> {
    const response = await asAdminA().post(ApiRoutes.finance.entries.manual).send(body)
    expect(response.status).toBe(CREATED)
    return response.body as EntryBody
  }
  async function chainOf(organizationId: string) {
    const rows = await owner.journalEntry.findMany({
      where: { organizationId },
      include: { lines: true },
      orderBy: { number: 'asc' }
    })
    return rows.map(row => ({
      ...row,
      entryDate: row.entryDate.toISOString().slice(0, 10),
      sourceDate: row.sourceDate === null ? null : row.sourceDate.toISOString().slice(0, 10)
    }))
  }

  describe('setting them up', () => {
    it('says that the books are not set up, and which countries have a template', async () => {
      const response = await asAdminB().get(ApiRoutes.finance.setup)

      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ ready: false, countries: ['SV'], settings: null })
    })

    it('refuses every read of the books before they exist, and tells the client to set them up', async () => {
      const response = await asAdminB().get(ApiRoutes.finance.settings)

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_SETUP_REQUIRED)
    })

    it('copies the template: the chart, a mapped account for every role, the payment accounts and two periods', async () => {
      const response = await asAdminB()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: 'SV', accountingStartDate: START })

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        ready: true,
        settings: {
          countryCode: 'SV',
          baseCurrency: 'USD',
          accountingStartDate: START,
          lockedThrough: null,
          recognizeSaleOn: 'delivered'
        }
      })
      const template = financeTemplateFor('SV')
      const rows = await owner.ledgerAccount.findMany({ where: { organizationId: ctx.orgB.id } })
      expect(rows).toHaveLength(template?.accounts.length ?? -1)
      expect(rows.every(row => row.isSystem && row.active && row.storeId === null)).toBe(true)
      const mappings = await owner.accountRoleMapping.findMany({
        where: { organizationId: ctx.orgB.id }
      })
      expect(mappings.map(row => row.role).sort()).toEqual(Object.values(AccountRole).sort())
      const payments = await owner.paymentMethodAccount.findMany({
        where: { organizationId: ctx.orgB.id }
      })
      expect(payments.map(row => row.paymentMethod).sort()).toEqual(
        [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.OTHER, PaymentMethod.TRANSFER].sort()
      )
      const periods = await owner.fiscalPeriod.findMany({
        where: { organizationId: ctx.orgB.id },
        orderBy: { month: 'asc' }
      })
      expect(periods.map(row => `${row.year}-${row.month}`)).toEqual(['2026-1', '2026-2'])
      const settings = await owner.financeSettings.findUniqueOrThrow({
        where: { organizationId: ctx.orgB.id }
      })
      const rounding = rows.find(row => row.id === settings.roundingAccountId)
      expect(rounding?.code).toBe('6111')
      // Nothing is posted: opening balances are a person's entry
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgB.id } })).toBe(0)
    })

    it('is done once: a second setup is a conflict and changes nothing', async () => {
      const before = await owner.ledgerAccount.count({ where: { organizationId: ctx.orgB.id } })

      const response = await asAdminB().post(ApiRoutes.finance.setup).send({ countryCode: 'SV' })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({
        conflict: FinanceConflicts.ALREADY_SET_UP
      })
      expect(await owner.ledgerAccount.count({ where: { organizationId: ctx.orgB.id } })).toBe(
        before
      )
    })

    it('refuses a start date outside the years of the calendar', async () => {
      const early = await asAdminA()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: 'SV', accountingStartDate: '1999-06-01' })
      const late = await asAdminA()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: 'SV', accountingStartDate: '2200-12-15' })

      expect([early.status, late.status]).toEqual([BAD_REQUEST, BAD_REQUEST])
    })

    it('refuses a country with no template and a date that is not a day', async () => {
      const country = await asAdminA().post(ApiRoutes.finance.setup).send({ countryCode: 'ZZ' })
      const date = await asAdminA()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: 'SV', accountingStartDate: '2026-02-31' })
      const extra = await asAdminA()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: 'SV', organizationId: ctx.orgB.id })

      expect([country.status, date.status, extra.status]).toEqual([
        BAD_REQUEST,
        BAD_REQUEST,
        BAD_REQUEST
      ])
    })

    it('leaves a record of who set them up', async () => {
      const entries = await waitForAuditEntries(owner, {
        organizationId: ctx.orgB.id,
        action: AuditAction.FINANCE_SETUP_COMPLETED
      })

      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        userId: ctx.adminB.id,
        metadata: { countryCode: 'SV', accountingStartDate: START }
      })
    })
  })

  describe('the permissions', () => {
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

    it('lets a role with only finance:view read balances, the chart and the periods, and nothing of the journal', async () => {
      const viewer = await asRole('only-view', [Permissions.FINANCE_VIEW])
      const entry = await postEntry(entryBody(RENT, CASH, 1_000))

      const reads = [
        await viewer.get(ApiRoutes.finance.balances),
        await viewer.get(ApiRoutes.finance.accounts.list),
        await viewer.get(ApiRoutes.finance.settings),
        await viewer.get(ApiRoutes.finance.periods.list),
        await viewer.get(ApiRoutes.finance.accountRoles.list),
        await viewer.get(ApiRoutes.finance.paymentAccounts.list)
      ]
      const refused = [
        await viewer.get(ApiRoutes.finance.entries.list),
        await viewer.get(ApiRoutes.finance.entries.byId(entry.id)),
        await viewer.post(ApiRoutes.finance.entries.manual).send(entryBody(RENT, CASH, 1_000)),
        await viewer.post(ApiRoutes.finance.entries.reverse(entry.id)).send({ memo: 'no' }),
        await viewer.post(ApiRoutes.finance.accounts.create).send({
          code: '9001',
          name: 'Nope',
          type: 'expense'
        }),
        await viewer.patch(ApiRoutes.finance.settings).send({ recognizeSaleOn: 'shipped' }),
        await viewer.get(ApiRoutes.finance.postings),
        await viewer.post(ApiRoutes.finance.setup).send({ countryCode: 'SV' })
      ]

      expect(reads.map(response => response.status)).toEqual(Array(reads.length).fill(OK))
      expect(refused.map(response => response.status)).toEqual(
        Array(refused.length).fill(FORBIDDEN)
      )
      expect(
        refused.every(response => errorOf(response).code === ErrorCodes.PERMISSION_DENIED)
      ).toBe(true)
    })

    it('lets finance:view_journal read the journal and not write it', async () => {
      const reader = await asRole('journal-reader', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL
      ])
      const entry = await postEntry(entryBody(RENT, CASH, 1_000))

      const list = await reader.get(ApiRoutes.finance.entries.list)
      const one = await reader.get(ApiRoutes.finance.entries.byId(entry.id))
      const post = await reader
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5))

      expect([list.status, one.status, post.status]).toEqual([OK, OK, FORBIDDEN])
    })

    it('lets finance:post_manual write entries and reverse them, and not change the chart', async () => {
      const accountant = await asRole('poster', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_POST_MANUAL
      ])

      const post = await accountant
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 700))
      const reverse = await accountant
        .post(ApiRoutes.finance.entries.reverse((post.body as EntryBody).id))
        .send({ memo: 'Posted by mistake' })
      const chart = await accountant
        .post(ApiRoutes.finance.accounts.create)
        .send({ code: '9002', name: 'Nope', type: 'expense' })

      expect([post.status, reverse.status, chart.status]).toEqual([CREATED, CREATED, FORBIDDEN])
    })

    it('lets finance:manage_accounts change the chart and the maps and not post an entry', async () => {
      const keeper = await asRole('chart-keeper', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_MANAGE_ACCOUNTS
      ])

      const create = await keeper
        .post(ApiRoutes.finance.accounts.create)
        .send({ code: `T${randomUUID().slice(0, 6)}`, name: 'Kept by the keeper', type: 'expense' })
      const post = await keeper
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5))
      const postings = await keeper.get(ApiRoutes.finance.postings)

      expect([create.status, post.status, postings.status]).toEqual([CREATED, FORBIDDEN, OK])
    })

    it('does not reach the books through the header of a store of another organization', async () => {
      const response = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.finance.settings)

      expect(response.status).toBe(FORBIDDEN)
    })
  })

  describe('the chart of accounts', () => {
    const newAccount = (extra: Record<string, unknown> = {}) => ({
      code: `A${randomUUID().slice(0, 8)}`,
      name: `Account ${randomUUID().slice(0, 6)}`,
      type: 'expense',
      ...extra
    })
    async function create(body: Record<string, unknown>): Promise<AccountBody> {
      const response = await asAdminA().post(ApiRoutes.finance.accounts.create).send(body)
      expect(response.status).toBe(CREATED)
      return response.body as AccountBody
    }

    it("lists it in the order of the accountant's codes, a page at a time", async () => {
      const first = await asAdminA().get(ApiRoutes.finance.accounts.list).query({ limit: 5 })
      const second = await asAdminA()
        .get(ApiRoutes.finance.accounts.list)
        .query({ limit: 5, cursor: (first.body as { nextCursor: string }).nextCursor })

      const codes = [
        ...(first.body as { data: AccountBody[] }).data,
        ...(second.body as { data: AccountBody[] }).data
      ].map(account => account.code)
      expect(first.status).toBe(OK)
      expect(codes).toHaveLength(10)
      expect(codes).toEqual([...codes].sort())
    })

    it('creates an account under a header of its own type, and refuses the places that break the chart', async () => {
      const header = await create(newAccount({ isPostable: false }))
      const child = await create(newAccount({ parentId: header.id }))
      const underPostable = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ parentId: child.id }))
      const wrongType = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ parentId: header.id, type: 'income' }))
      const cashKindOnLiability = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ type: 'liability', cashKind: 'bank' }))
      const badCode = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ code: 'has space' }))

      expect(child).toMatchObject({
        parentId: header.id,
        isPostable: true,
        isSystem: false,
        active: true
      })
      expect([
        underPostable.status,
        wrongType.status,
        cashKindOnLiability.status,
        badCode.status
      ]).toEqual([BAD_REQUEST, BAD_REQUEST, BAD_REQUEST, BAD_REQUEST])
    })

    it('does not name an account of another organization as a parent', async () => {
      const foreign = await owner.ledgerAccount.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, isPostable: false }
      })

      const response = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ parentId: foreign.id }))

      expect(response.status).toBe(NOT_FOUND)
    })

    it('keeps one code per organization, and the same code is free in another', async () => {
      const taken = await create(newAccount())

      const again = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ code: taken.code }))
      const elsewhere = await asAdminB()
        .post(ApiRoutes.finance.accounts.create)
        .send(newAccount({ code: taken.code }))

      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata).toMatchObject({
        conflict: FinanceConflicts.ACCOUNT_CODE_IN_USE
      })
      expect(elsewhere.status).toBe(CREATED)
    })

    it('renames and moves an account, and records what it was and what it is', async () => {
      const header = await create(newAccount({ isPostable: false }))
      const account = await create(newAccount())

      const response = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(account.id))
        .send({ name: 'Renamed by the suite', parentId: header.id })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ name: 'Renamed by the suite', parentId: header.id })
      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_ACCOUNT_UPDATED,
        resourceId: account.id
      })
      expect(logged[0]?.metadata).toMatchObject({
        fields: ['name', 'parentId'],
        changes: { name: { from: account.name, to: 'Renamed by the suite' } }
      })
    })

    it('does not put a header under its own child', async () => {
      const header = await create(newAccount({ isPostable: false }))
      const group = await create(newAccount({ isPostable: false, parentId: header.id }))

      const response = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(header.id))
        .send({ parentId: group.id })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('locks the type of an account once it has entries, and keeps it an account that takes entries', async () => {
      const used = await create(newAccount())
      // The helper takes codes of the starter chart: the new account is named by id
      await postEntry({
        ...entryBody(RENT, CASH, 300),
        lines: [
          { accountId: used.id, debitCents: 300 },
          { accountId: accounts[CASH], creditCents: 300 }
        ]
      })

      const type = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(used.id))
        .send({ type: 'income' })
      const header = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(used.id))
        .send({ isPostable: false })
      const rename = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(used.id))
        .send({ name: 'Still renamable' })

      expect(errorOf(type).code).toBe(ErrorCodes.FINANCE_ACCOUNT_TYPE_LOCKED)
      expect(errorOf(header).code).toBe(ErrorCodes.FINANCE_ACCOUNT_HAS_ENTRIES)
      expect(rename.status).toBe(OK)
    })

    it('switches an account off and on, refusing one that a role or a payment method uses', async () => {
      const free = await create(newAccount())

      const off = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(free.id))
      const offAgain = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(free.id))
      const on = await asAdminA().post(ApiRoutes.finance.accounts.reactivate(free.id))
      const mapped = await asAdminA().post(
        ApiRoutes.finance.accounts.deactivate(accounts[CASH] ?? '')
      )

      expect((off.body as AccountBody).active).toBe(false)
      expect(offAgain.status).toBe(OK)
      expect((on.body as AccountBody).active).toBe(true)
      expect(mapped.status).toBe(CONFLICT)
      expect(errorOf(mapped).metadata).toMatchObject({
        conflict: FinanceConflicts.ACCOUNT_IN_USE_BY_SETTING
      })
      // Once: the second switch-off found it off already and left no second record
      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_ACCOUNT_DEACTIVATED,
        resourceId: free.id
      })
      await settle()
      expect(await auditCount(logged)).toBe(1)
    })

    it('keeps the type and the kind of cash of an account that a role or a payment method uses', async () => {
      const type = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(accounts['4101'] ?? ''))
        .send({ type: 'expense' })
      const kind = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(accounts[CASH] ?? ''))
        .send({ cashKind: null })

      expect([type.status, kind.status]).toEqual([CONFLICT, CONFLICT])
    })

    it('never reaches an account of another organization, by id', async () => {
      const foreign = await owner.ledgerAccount.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, isPostable: true }
      })

      const read = await asAdminA().get(ApiRoutes.finance.accounts.byId(foreign.id))
      const rename = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(foreign.id))
        .send({ name: 'taken' })
      const off = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(foreign.id))

      expect([read.status, rename.status, off.status]).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND])
      const after = await owner.ledgerAccount.findUniqueOrThrow({ where: { id: foreign.id } })
      expect(after).toMatchObject({ name: foreign.name, active: true })
    })
  })

  describe('the maps of roles and payment methods', () => {
    it('lists the account of every role', async () => {
      const response = await asAdminA().get(ApiRoutes.finance.accountRoles.list)

      expect((response.body as { role: string }[]).map(row => row.role).sort()).toEqual(
        Object.values(AccountRole).sort()
      )
    })

    it('points a role at another account, and refuses a header, an account that is off and one of another organization', async () => {
      const target = accounts[BANK] ?? ''
      const header = accounts['1'] ?? ''
      const off = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send({ code: `O${randomUUID().slice(0, 6)}`, name: 'Off', type: 'asset' })
      await asAdminA().post(ApiRoutes.finance.accounts.deactivate((off.body as AccountBody).id))
      const foreign = await owner.ledgerAccount.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, isPostable: true }
      })

      const ok = await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole(AccountRole.CASH_DEFAULT))
        .send({ accountId: target })
      const toHeader = await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole(AccountRole.CASH_DEFAULT))
        .send({ accountId: header })
      const toOff = await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole(AccountRole.CASH_DEFAULT))
        .send({ accountId: (off.body as AccountBody).id })
      const toForeign = await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole(AccountRole.CASH_DEFAULT))
        .send({ accountId: foreign.id })
      const unknownRole = await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole('not_a_role'))
        .send({ accountId: target })

      expect(ok.status).toBe(OK)
      expect(errorOf(toHeader).code).toBe(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE)
      expect(errorOf(toOff).code).toBe(ErrorCodes.FINANCE_ACCOUNT_INACTIVE)
      expect(toForeign.status).toBe(NOT_FOUND)
      expect(unknownRole.status).toBe(BAD_REQUEST)
      const stored = await owner.accountRoleMapping.findUniqueOrThrow({
        where: {
          organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.CASH_DEFAULT }
        }
      })
      expect(stored.accountId).toBe(target)
      // Back to the cash box for the cases after this one
      await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole(AccountRole.CASH_DEFAULT))
        .send({ accountId: accounts[CASH] })
      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_ROLE_MAPPED,
        // The record of this change, not whichever mapping of the role came first (the switch back
        // to the cash box and the earlier cases leave their own)
        metadata: { path: ['to'], equals: target }
      })
      expect(logged[0]?.metadata).toMatchObject({ role: AccountRole.CASH_DEFAULT, to: target })
    })

    it('chooses the account of a payment method for a store, falls back to the default, and keeps the default', async () => {
      const set = await asAdminA().put(ApiRoutes.finance.paymentAccounts.set).send({
        paymentMethod: PaymentMethod.CARD,
        storeId: ctx.storeA.id,
        accountId: accounts[CASH]
      })
      const again = await asAdminA().put(ApiRoutes.finance.paymentAccounts.set).send({
        paymentMethod: PaymentMethod.CARD,
        storeId: ctx.storeA.id,
        accountId: accounts[BANK]
      })
      const list = await asAdminA().get(ApiRoutes.finance.paymentAccounts.list)
      const def = (list.body as { id: string; storeId: string | null }[]).find(
        row => row.storeId === null
      )

      const removed = await asAdminA().delete(
        ApiRoutes.finance.paymentAccounts.byId((set.body as { id: string }).id)
      )
      const keepDefault = await asAdminA().delete(
        ApiRoutes.finance.paymentAccounts.byId(def?.id ?? '')
      )

      expect(set.status).toBe(OK)
      // The same choice again is the same row
      expect((again.body as { id: string }).id).toBe((set.body as { id: string }).id)
      expect(removed.status).toBe(NO_CONTENT)
      expect(keepDefault.status).toBe(CONFLICT)
      expect(errorOf(keepDefault).metadata).toMatchObject({
        conflict: FinanceConflicts.DEFAULT_PAYMENT_ACCOUNT
      })
    })

    it('refuses collect on delivery, a store of another organization and an account of another organization', async () => {
      const foreignAccount = await owner.ledgerAccount.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, isPostable: true }
      })

      const cod = await asAdminA()
        .put(ApiRoutes.finance.paymentAccounts.set)
        .send({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY, accountId: accounts[CASH] })
      const store = await asAdminA().put(ApiRoutes.finance.paymentAccounts.set).send({
        paymentMethod: PaymentMethod.CASH,
        storeId: ctx.storeB.id,
        accountId: accounts[CASH]
      })
      const account = await asAdminA()
        .put(ApiRoutes.finance.paymentAccounts.set)
        .send({ paymentMethod: PaymentMethod.CASH, accountId: foreignAccount.id })

      expect([cod.status, store.status, account.status]).toEqual([
        BAD_REQUEST,
        NOT_FOUND,
        NOT_FOUND
      ])
    })

    it('keeps the rounding account and the rounding role as one, from either end', async () => {
      const viaSettings = await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ roundingAccountId: accounts['6112'] })
      const rolesAfterSettings = await asAdminA().get(ApiRoutes.finance.accountRoles.list)
      const viaRole = await asAdminA()
        .put(ApiRoutes.finance.accountRoles.byRole(AccountRole.ROUNDING))
        .send({ accountId: accounts['6111'] })
      const settings = await asAdminA().get(ApiRoutes.finance.settings)
      const cleared = await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ roundingAccountId: null })

      expect(viaSettings.status).toBe(OK)
      const rounding = (rolesAfterSettings.body as { role: string; accountId: string }[]).find(
        row => row.role === (AccountRole.ROUNDING as string)
      )
      expect(rounding?.accountId).toBe(accounts['6112'])
      expect(viaRole.status).toBe(OK)
      expect((settings.body as { roundingAccountId: string }).roundingAccountId).toBe(
        accounts['6111']
      )
      expect(cleared.status).toBe(BAD_REQUEST)
    })

    it('changes the settings: the moment of a sale and the rounding account', async () => {
      const response = await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ recognizeSaleOn: 'shipped', roundingAccountId: accounts['6112'] })
      const header = await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ roundingAccountId: accounts['6'] })
      const nothing = await asAdminA().patch(ApiRoutes.finance.settings).send({})
      const dates = await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ accountingStartDate: '2020-01-01' })

      expect(response.body).toMatchObject({
        recognizeSaleOn: 'shipped',
        roundingAccountId: accounts['6112']
      })
      expect(errorOf(header).code).toBe(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE)
      expect([nothing.status, dates.status]).toEqual([BAD_REQUEST, BAD_REQUEST])
      // Put back for the cases after this one
      await asAdminA()
        .patch(ApiRoutes.finance.settings)
        .send({ recognizeSaleOn: 'delivered', roundingAccountId: accounts['6111'] })
    })
  })

  describe('the periods', () => {
    it('opens the period of a month once, and lists the newest first', async () => {
      const first = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: 2027, month: 3 })
      const again = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: 2027, month: 3 })
      const list = await asAdminA().get(ApiRoutes.finance.periods.list).query({ limit: 2 })

      expect(first.body).toMatchObject({
        year: 2027,
        month: 3,
        startsOn: '2027-03-01',
        endsOn: '2027-03-31',
        status: PeriodStatus.OPEN
      })
      expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id)
      expect((list.body as { data: { year: number; month: number }[] }).data[0]).toMatchObject({
        year: 2027,
        month: 3
      })
    })

    it('leaves a record of the period it opened, and none for one that was there', async () => {
      const opened = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: 2028, month: 5 })
      await asAdminA().post(ApiRoutes.finance.periods.open).send({ year: 2028, month: 5 })

      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_PERIOD_OPENED,
        resourceId: (opened.body as { id: string }).id
      })
      await settle()
      expect(await auditCount(logged)).toBe(1)
    })

    it('does not open a month that ended before the books started, nor one of another organization by id', async () => {
      const before = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: 2025, month: 12 })
      const foreign = await owner.fiscalPeriod.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id }
      })
      const read = await asAdminA().get(ApiRoutes.finance.periods.byId(foreign.id))

      expect(errorOf(before).code).toBe(ErrorCodes.FINANCE_BEFORE_START_DATE)
      expect(read.status).toBe(NOT_FOUND)
    })
  })

  describe('posting an entry by hand', () => {
    it('writes a balanced entry with its number, its author, its hash and its lines', async () => {
      const body = entryBody(RENT, CASH, 12_345, { memo: '  Rent of November  ' })

      const entry = await postEntry(body)

      expect(entry).toMatchObject({
        type: JournalEntryType.MANUAL,
        entryDate: DATE,
        memo: 'Rent of November',
        totalCents: 12_345,
        createdBy: ctx.adminA.id,
        origin: 'user',
        reversesEntryId: null,
        reversedByEntryId: null
      })
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.lines.map(line => [line.lineNo, line.debitCents, line.creditCents])).toEqual([
        [1, 12_345, 0],
        [2, 0, 12_345]
      ])
      const read = await asAdminA().get(ApiRoutes.finance.entries.byId(entry.id))
      expect((read.body as EntryBody).hash).toBe(entry.hash)
      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_ENTRY_POSTED_MANUAL,
        resourceId: entry.id
      })
      expect(logged[0]).toMatchObject({ userId: ctx.adminA.id, metadata: { totalCents: 12_345 } })
    })

    it('chains the entries: gapless numbers, and each one points at the hash of the one before', async () => {
      await postEntry(entryBody(MARKETING, BANK, 100))
      await postEntry(entryBody(MARKETING, BANK, 200))

      const rows = await chainOf(ctx.orgA.id)

      expect(rows.length).toBeGreaterThanOrEqual(3)
      expect(rows.map(row => Number(row.number))).toEqual(rows.map((_, index) => index + 1))
      expect(verifyChain(rows)).toBeNull()
    })

    it('keeps the number gapless and the chain whole when many are posted at once', async () => {
      const before = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })

      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          asAdminA()
            .post(ApiRoutes.finance.entries.manual)
            .send(entryBody(MARKETING, BANK, 10 + index))
        )
      )

      expect(answers.map(answer => answer.status)).toEqual(Array(8).fill(CREATED))
      const rows = await chainOf(ctx.orgA.id)
      expect(rows).toHaveLength(before + 8)
      expect(rows.map(row => Number(row.number))).toEqual(rows.map((_, index) => index + 1))
      expect(verifyChain(rows)).toBeNull()
    })

    it('answers a retry with the entry of the first try and writes nothing more', async () => {
      const body = entryBody(RENT, CASH, 555)
      const first = await postEntry(body)
      const count = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })

      const retry = await asAdminA().post(ApiRoutes.finance.entries.manual).send(body)

      expect(retry.status).toBe(CREATED)
      expect((retry.body as EntryBody).id).toBe(first.id)
      expect((retry.body as EntryBody).number).toBe(first.number)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(count)
      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_ENTRY_POSTED_MANUAL,
        resourceId: first.id
      })
      await settle()
      expect(await auditCount(logged)).toBe(1)
    })

    it('refuses the same key with another content: it is a mistake, never an overwrite', async () => {
      const body = entryBody(RENT, CASH, 777)
      await postEntry(body)

      const other = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send({ ...body, lines: entryBody(RENT, CASH, 778).lines })

      expect(other.status).toBe(CONFLICT)
      expect(errorOf(other).code).toBe(ErrorCodes.RESOURCE_CONFLICT)
    })

    it('does not hand another author the entry of the first as a retry of theirs', async () => {
      const body = entryBody(RENT, CASH, 43)
      await postEntry(body)

      const other = await api(app, ctx.adminA2, ctx.storeA2)
        .post(ApiRoutes.finance.entries.manual)
        .send(body)

      expect(other.status).toBe(CONFLICT)
    })

    it('does not take the same key from another organization as its own', async () => {
      const shared = key()
      const mine = await postEntry({ ...entryBody(RENT, CASH, 41), idempotencyKey: shared })
      const accountsB = await accountIds(ctx.orgB.id)

      const theirs = await asAdminB()
        .post(ApiRoutes.finance.entries.manual)
        .send({
          idempotencyKey: shared,
          entryDate: DATE,
          type: JournalEntryType.MANUAL,
          memo: 'Their own',
          lines: [
            { accountId: accountsB[RENT], debitCents: 41 },
            { accountId: accountsB[CASH], creditCents: 41 }
          ]
        })

      expect(theirs.status).toBe(CREATED)
      expect((theirs.body as EntryBody).id).not.toBe(mine.id)
    })

    it('refuses an entry that does not balance, one with a line on both sides and one with fewer than two lines', async () => {
      const unbalanced = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(
          entryBody(RENT, CASH, 100, {
            lines: [
              { accountId: accounts[RENT], debitCents: 100 },
              { accountId: accounts[CASH], creditCents: 99 }
            ]
          })
        )
      const bothSides = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(
          entryBody(RENT, CASH, 100, {
            lines: [
              { accountId: accounts[RENT], debitCents: 100, creditCents: 100 },
              { accountId: accounts[CASH], creditCents: 100 }
            ]
          })
        )
      const oneLine = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(
          entryBody(RENT, CASH, 100, { lines: [{ accountId: accounts[RENT], debitCents: 100 }] })
        )
      const fraction = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(
          entryBody(RENT, CASH, 100, {
            lines: [
              { accountId: accounts[RENT], debitCents: 10.5 },
              { accountId: accounts[CASH], creditCents: 10.5 }
            ]
          })
        )
      const empty = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 0))

      expect(errorOf(unbalanced).code).toBe(ErrorCodes.FINANCE_ENTRY_UNBALANCED)
      expect(errorOf(unbalanced).metadata).toMatchObject({ rules: ['debits_equal_credits'] })
      expect(errorOf(bothSides).code).toBe(ErrorCodes.FINANCE_ENTRY_UNBALANCED)
      expect([oneLine.status, fraction.status, empty.status]).toEqual([
        BAD_REQUEST,
        BAD_REQUEST,
        BAD_REQUEST
      ])
      expect(errorOf(empty).code).toBe(ErrorCodes.FINANCE_ENTRY_UNBALANCED)
    })

    it('asks for the reason, a real day and a key, and refuses what it does not know', async () => {
      const noMemo = { ...entryBody(RENT, CASH, 5), memo: '   ' }
      const badDay = entryBody(RENT, CASH, 5, { entryDate: '2026-02-30' })
      const shortKey = entryBody(RENT, CASH, 5, { idempotencyKey: 'x' })
      const party = entryBody(RENT, CASH, 5, {
        lines: [
          {
            accountId: accounts[RENT],
            debitCents: 5,
            partyType: 'supplier',
            partyId: randomUUID()
          },
          { accountId: accounts[CASH], creditCents: 5 }
        ]
      })
      const system = entryBody(RENT, CASH, 5, { origin: 'system' })

      const statuses = []
      for (const body of [noMemo, badDay, shortKey, party, system]) {
        statuses.push((await asAdminA().post(ApiRoutes.finance.entries.manual).send(body)).status)
      }

      expect(statuses).toEqual(Array(5).fill(BAD_REQUEST))
    })

    it('refuses a date outside the years of the calendar, and makes no period for it', async () => {
      const periods = await owner.fiscalPeriod.count({ where: { organizationId: ctx.orgA.id } })

      const far = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5, { entryDate: '2999-01-01' }))

      expect(far.status).toBe(BAD_REQUEST)
      expect(await owner.fiscalPeriod.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        periods
      )
    })

    it('refuses a date before the books start', async () => {
      const response = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5, { entryDate: '2025-12-31' }))

      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_BEFORE_START_DATE)
    })

    it('refuses a header, an account that is off, an account of another organization and a store of another', async () => {
      const off = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send({ code: `X${randomUUID().slice(0, 6)}`, name: 'Closed for entries', type: 'expense' })
      await asAdminA().post(ApiRoutes.finance.accounts.deactivate((off.body as AccountBody).id))
      const foreign = await owner.ledgerAccount.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, isPostable: true }
      })
      const lines = (debitAccountId: string, extra: Record<string, unknown> = {}) => ({
        lines: [
          { accountId: debitAccountId, debitCents: 5, ...extra },
          { accountId: accounts[CASH], creditCents: 5 }
        ]
      })

      const header = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5, lines(accounts['6'] ?? '')))
      const inactive = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5, lines((off.body as AccountBody).id)))
      const other = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5, lines(foreign.id)))
      const store = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(entryBody(RENT, CASH, 5, lines(accounts[RENT] ?? '', { storeId: ctx.storeB.id })))

      expect(errorOf(header).code).toBe(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE)
      expect(errorOf(inactive).code).toBe(ErrorCodes.FINANCE_ACCOUNT_INACTIVE)
      expect([other.status, store.status]).toEqual([NOT_FOUND, NOT_FOUND])
    })

    it('keeps the line of a store as a dimension, and the balances by period follow the lines', async () => {
      const period = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: 2026, month: 8 })
      const periodId = (period.body as { id: string }).id
      const entry = await postEntry(
        entryBody(MARKETING, BANK, 4_000, {
          entryDate: '2026-08-15',
          lines: [
            { accountId: accounts[MARKETING], debitCents: 4_000, storeId: ctx.storeA.id },
            { accountId: accounts[BANK], creditCents: 4_000 }
          ]
        })
      )

      const all = await asAdminA().get(ApiRoutes.finance.balances).query({ periodId })
      const forStore = await asAdminA()
        .get(ApiRoutes.finance.balances)
        .query({ periodId, storeId: ctx.storeA.id })
      const otherStore = await asAdminA()
        .get(ApiRoutes.finance.balances)
        .query({ periodId, storeId: ctx.storeA2.id })

      expect(entry.lines[0]?.storeId).toBe(ctx.storeA.id)
      const byAccount = (body: BalanceBody, id: string | undefined) =>
        body.data.find(row => row.accountId === id)
      expect(byAccount(all.body as BalanceBody, accounts[MARKETING])).toMatchObject({
        debitCents: '4000',
        creditCents: '0',
        balanceCents: '4000'
      })
      // The bank grows on the debit side: a credit of 4000 is a balance of -4000
      expect(byAccount(all.body as BalanceBody, accounts[BANK])).toMatchObject({
        balanceCents: '-4000'
      })
      expect(byAccount(forStore.body as BalanceBody, accounts[MARKETING])?.debitCents).toBe('4000')
      expect(byAccount(forStore.body as BalanceBody, accounts[BANK])).toBeUndefined()
      expect((otherStore.body as BalanceBody).data).toEqual([])
    })

    it('refuses the balances of a period of another organization', async () => {
      const foreign = await owner.fiscalPeriod.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id }
      })

      const response = await asAdminA()
        .get(ApiRoutes.finance.balances)
        .query({ periodId: foreign.id })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('lists the journal newest first, filters it, and pages with the number', async () => {
      const first = await asAdminA().get(ApiRoutes.finance.entries.list).query({ limit: 3 })
      const second = await asAdminA()
        .get(ApiRoutes.finance.entries.list)
        .query({ limit: 3, cursor: (first.body as { nextCursor: string }).nextCursor })
      const forAccount = await asAdminA()
        .get(ApiRoutes.finance.entries.list)
        .query({ accountId: accounts[BANK], limit: 100 })

      const numbers = [
        ...(first.body as { data: EntryBody[] }).data,
        ...(second.body as { data: EntryBody[] }).data
      ].map(row => Number(row.number))
      expect(numbers).toEqual([...numbers].sort((a, b) => b - a))
      expect(new Set(numbers).size).toBe(6)
      const touched = (forAccount.body as { data: EntryBody[] }).data
      const expected = await owner.journalEntry.count({
        where: { organizationId: ctx.orgA.id, lines: { some: { accountId: accounts[BANK] } } }
      })
      expect(touched).toHaveLength(expected)
      expect(touched.length).toBeGreaterThan(0)
      for (const row of touched) {
        const full = await owner.journalLine.count({
          where: { entryId: row.id, accountId: accounts[BANK] }
        })
        expect(full).toBeGreaterThan(0)
      }
    })
  })

  describe('reversing an entry', () => {
    it('writes the entry with the sides swapped, points at the original and leaves the original as it was', async () => {
      const original = await postEntry(entryBody(RENT, CASH, 9_000))
      const stored = await owner.journalEntry.findUniqueOrThrow({ where: { id: original.id } })

      const response = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Entered twice' })

      expect(response.status).toBe(CREATED)
      const reversal = response.body as EntryBody
      expect(reversal).toMatchObject({
        type: JournalEntryType.REVERSAL,
        reversesEntryId: original.id,
        memo: 'Entered twice',
        totalCents: 9_000,
        entryDate: DATE
      })
      expect(
        reversal.lines.map(line => [line.accountId, line.debitCents, line.creditCents])
      ).toEqual([
        [accounts[RENT], 0, 9_000],
        [accounts[CASH], 9_000, 0]
      ])
      const after = await owner.journalEntry.findUniqueOrThrow({ where: { id: original.id } })
      expect(after).toEqual(stored)
      const shown = await asAdminA().get(ApiRoutes.finance.entries.byId(original.id))
      expect((shown.body as EntryBody).reversedByEntryId).toBe(reversal.id)
      const logged = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_ENTRY_REVERSED,
        resourceId: original.id
      })
      expect(logged[0]?.metadata).toMatchObject({ reversalEntryId: reversal.id })
      expect(verifyChain(await chainOf(ctx.orgA.id))).toBeNull()
    })

    it('is done once: a second try, whatever it says, is the first reversal and writes nothing', async () => {
      const original = await postEntry(entryBody(RENT, CASH, 80))
      const first = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'First' })
      const count = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })

      const again = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Second' })

      expect((again.body as EntryBody).id).toBe((first.body as EntryBody).id)
      expect((again.body as EntryBody).memo).toBe('First')
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(count)
      expect(await owner.journalEntry.count({ where: { reversesEntryId: original.id } })).toBe(1)
    })

    it('answers a retry of a reversal with the reversal of the first try', async () => {
      const original = await postEntry(entryBody(RENT, CASH, 90))
      const first = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Once' })
      const count = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })

      const retry = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Once' })

      expect(retry.status).toBe(CREATED)
      expect((retry.body as EntryBody).id).toBe((first.body as EntryBody).id)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(count)
    })

    it('does not reverse a reversal, and does not date one before its entry', async () => {
      const original = await postEntry(entryBody(RENT, CASH, 95))
      const early = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Too early', entryDate: '2026-11-09' })
      const reversal = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Back out' })

      const again = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse((reversal.body as EntryBody).id))
        .send({ memo: 'Undo the undo' })

      expect(early.status).toBe(BAD_REQUEST)
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata).toMatchObject({
        conflict: FinanceConflicts.REVERSAL_NOT_REVERSIBLE
      })
    })

    it('takes an entry whose account was switched off meanwhile, which no new entry may use', async () => {
      const account = await asAdminA()
        .post(ApiRoutes.finance.accounts.create)
        .send({ code: `R${randomUUID().slice(0, 6)}`, name: 'Used and closed', type: 'expense' })
      const accountId = (account.body as AccountBody).id
      const original = await postEntry({
        ...entryBody(RENT, CASH, 60),
        lines: [
          { accountId, debitCents: 60 },
          { accountId: accounts[CASH], creditCents: 60 }
        ]
      })
      await asAdminA().post(ApiRoutes.finance.accounts.deactivate(accountId))

      const reversal = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(original.id))
        .send({ memo: 'Account closed' })

      expect(reversal.status).toBe(CREATED)
    })

    it('needs the reason, and does not reverse an entry of another organization', async () => {
      const mine = await postEntry(entryBody(RENT, CASH, 70))
      const foreignAccounts = await accountIds(ctx.orgB.id)
      const theirs = await asAdminB()
        .post(ApiRoutes.finance.entries.manual)
        .send({
          idempotencyKey: key(),
          entryDate: DATE,
          type: JournalEntryType.MANUAL,
          memo: 'Theirs',
          lines: [
            { accountId: foreignAccounts[RENT], debitCents: 70 },
            { accountId: foreignAccounts[CASH], creditCents: 70 }
          ]
        })
      const theirId = (theirs.body as EntryBody).id

      const noReason = await asAdminA().post(ApiRoutes.finance.entries.reverse(mine.id)).send({})
      const across = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(theirId))
        .send({ memo: 'Not mine' })
      const read = await asAdminA().get(ApiRoutes.finance.entries.byId(theirId))

      expect([noReason.status, across.status, read.status]).toEqual([
        BAD_REQUEST,
        NOT_FOUND,
        NOT_FOUND
      ])
      expect(await owner.journalEntry.count({ where: { reversesEntryId: theirId } })).toBe(0)
    })
  })

  describe('a closed period', () => {
    // Organization B, where the books were set up above: two entries are written in January, then January is closed and the
    // lock of the books is the end of it
    const january: string[] = []
    let accountsB: Record<string, string> = {}
    const bodyB = (entryDate: string, cents = 15) => ({
      idempotencyKey: key(),
      entryDate,
      type: JournalEntryType.MANUAL,
      memo: 'Dated by the suite',
      lines: [
        { accountId: accountsB[RENT], debitCents: cents },
        { accountId: accountsB[CASH], creditCents: cents }
      ]
    })

    beforeAll(async () => {
      accountsB = await accountIds(ctx.orgB.id)
      for (const cents of [25, 26]) {
        const response = await asAdminB()
          .post(ApiRoutes.finance.entries.manual)
          .send(bodyB('2026-01-15', cents))
        expect(response.status).toBe(CREATED)
        january.push((response.body as EntryBody).id)
      }
      const period = await owner.fiscalPeriod.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, year: 2026, month: 1 }
      })
      await owner.fiscalPeriod.update({
        where: { id: period.id },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: 'the-closer' }
      })
      await owner.financeSettings.update({
        where: { organizationId: ctx.orgB.id },
        data: { lockedThrough: day('2026-01-31') }
      })
    })

    it('takes no entry dated in it, and takes one dated after it', async () => {
      const closed = await asAdminB()
        .post(ApiRoutes.finance.entries.manual)
        .send(bodyB('2026-01-20'))
      const open = await asAdminB().post(ApiRoutes.finance.entries.manual).send(bodyB('2026-02-03'))

      expect(errorOf(closed).code).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
      expect(open.status).toBe(CREATED)
    })

    it('reverses an entry of the closed period in the open one, and keeps its date out of the closed one', async () => {
      const inside = await asAdminB()
        .post(ApiRoutes.finance.entries.reverse(january[0] ?? ''))
        .send({ memo: 'Back out', entryDate: '2026-01-31' })
      const reversal = await asAdminB()
        .post(ApiRoutes.finance.entries.reverse(january[0] ?? ''))
        .send({ memo: 'Back out' })

      expect(errorOf(inside).code).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
      expect(reversal.status).toBe(CREATED)
      // The date of the entry is the first day of the open period: the books of January did not change
      expect((reversal.body as EntryBody).entryDate).toBe('2026-02-01')
      expect((reversal.body as EntryBody).reversesEntryId).toBe(january[0])
    })

    it('takes a reversal on a date the person chose in the open period', async () => {
      const reversal = await asAdminB()
        .post(ApiRoutes.finance.entries.reverse(january[1] ?? ''))
        .send({ memo: 'Back out later', entryDate: '2026-02-20' })

      expect(reversal.status).toBe(CREATED)
      expect((reversal.body as EntryBody).entryDate).toBe('2026-02-20')
    })
  })

  describe('the postings that wait', () => {
    it('lists the failed sources that are not resolved, of the organization only', async () => {
      const mine = await owner.financePostingFailure.create({
        data: {
          organizationId: ctx.orgA.id,
          sourceType: 'order',
          sourceId: randomUUID(),
          eventKind: 'sale',
          reason: 'role_not_mapped'
        }
      })
      const done = await owner.financePostingFailure.create({
        data: {
          organizationId: ctx.orgA.id,
          sourceType: 'order',
          sourceId: randomUUID(),
          eventKind: 'sale',
          reason: 'role_not_mapped',
          resolvedAt: new Date()
        }
      })
      const theirs = await owner.financePostingFailure.create({
        data: {
          organizationId: ctx.orgB.id,
          sourceType: 'order',
          sourceId: randomUUID(),
          eventKind: 'sale',
          reason: 'role_not_mapped'
        }
      })

      const response = await asAdminA().get(ApiRoutes.finance.postings)

      const ids = (response.body as { data: { id: string }[] }).data.map(row => row.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(done.id)
      expect(ids).not.toContain(theirs.id)
    })
  })
})
