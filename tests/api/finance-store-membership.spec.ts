import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions, RoleNames } from '@platform/core/auth'
import { ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinanceTransactionKind,
  JournalEntryType,
  MembershipStatus,
  PaymentMethod
} from '@platform/core/domain'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// SEG-228 (owner decision, QA of 2026-11-23): the store that a figure of the books is charged to is one the person is a member of. The id of
// a store in the body of a transaction, of a line of a manual entry or of a payment-method account is a dimension, never a way to reach a
// sibling store of the organization that the person cannot open.
const OK = 200
const CREATED = 201
const NOT_FOUND = 404

const CASH = '1101'
const SERVICES = '6106'
const RENT = '6101'

describe('The store a book entry is charged to (SEG-228)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // A member of the first store ONLY, with every finance permission that writes
  const onlyFirstStore = () =>
    actorWithPermissions(owner, app, {
      prefix,
      name: `solo-${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_MANAGE_TRANSACTIONS,
        Permissions.FINANCE_POST_MANUAL,
        Permissions.FINANCE_MANAGE_ACCOUNTS
      ]
    })

  const expense = (extra: Record<string, unknown>) => ({
    idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
    kind: FinanceTransactionKind.EXPENSE,
    occurredOn: new Date().toISOString().slice(0, 10),
    amountCents: 1_000,
    fromAccountId: accounts[CASH],
    categoryAccountId: accounts[SERVICES],
    ...extra
  })
  const entry = (lineStore: Record<string, unknown>) => ({
    idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
    entryDate: new Date().toISOString().slice(0, 10),
    type: JournalEntryType.MANUAL,
    memo: 'SEG-228',
    lines: [
      { accountId: accounts[RENT], debitCents: 500, ...lineStore },
      { accountId: accounts[CASH], creditCents: 500 }
    ]
  })

  describe('a member of one store only', () => {
    it('cannot charge a transaction to a sibling store, and writes nothing', async () => {
      const solo = await onlyFirstStore()
      const before = await owner.financeTransaction.count({
        where: { organizationId: ctx.orgA.id }
      })
      const refused = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.transactions.record)
        .send(expense({ storeId: ctx.storeA2.id }))
      expect(refused.status).toBe(NOT_FOUND)
      expect(await owner.financeTransaction.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before
      )

      const own = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.transactions.record)
        .send(expense({ storeId: ctx.storeA.id }))
      expect(own.status).toBe(CREATED)
      const none = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.transactions.record)
        .send(expense({}))
      expect(none.status).toBe(CREATED)
    })

    it('cannot charge the line of a manual entry to a sibling store, and writes nothing', async () => {
      const solo = await onlyFirstStore()
      const before = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })
      const refused = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.entries.manual)
        .send(entry({ storeId: ctx.storeA2.id }))
      expect(refused.status).toBe(NOT_FOUND)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before
      )
      const own = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.entries.manual)
        .send(entry({ storeId: ctx.storeA.id }))
      expect(own.status).toBe(CREATED)
    })

    it('cannot set the account of a payment method for a sibling store', async () => {
      const solo = await onlyFirstStore()
      const refused = await api(app, solo, ctx.storeA)
        .put(ApiRoutes.finance.paymentAccounts.set)
        .send({
          paymentMethod: PaymentMethod.CASH,
          storeId: ctx.storeA2.id,
          accountId: accounts[CASH]
        })
      expect(refused.status).toBe(NOT_FOUND)
      expect(
        await owner.paymentMethodAccount.count({
          where: { organizationId: ctx.orgA.id, storeId: ctx.storeA2.id }
        })
      ).toBe(0)
      const own = await api(app, solo, ctx.storeA).put(ApiRoutes.finance.paymentAccounts.set).send({
        paymentMethod: PaymentMethod.CASH,
        storeId: ctx.storeA.id,
        accountId: accounts[CASH]
      })
      expect(own.status).toBe(OK)
    })
  })

  describe('taking a choice away and repeating a request', () => {
    it('cannot remove the account a sibling store chose, and the choice stays', async () => {
      const chosen = await owner.paymentMethodAccount.create({
        data: {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          paymentMethod: PaymentMethod.CARD,
          accountId: accounts[CASH] ?? ''
        }
      })
      const solo = await onlyFirstStore()
      const refused = await api(app, solo, ctx.storeA).delete(
        ApiRoutes.finance.paymentAccounts.byId(chosen.id)
      )
      expect(refused.status).toBe(NOT_FOUND)
      expect(await owner.paymentMethodAccount.count({ where: { id: chosen.id } })).toBe(1)
    })

    it('does not give back a transaction charged to a store the person no longer belongs to', async () => {
      const solo = await onlyFirstStore()
      await ensureMembership(owner, {
        userId: solo.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      const body = expense({ storeId: ctx.storeA2.id })
      const first = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.transactions.record)
        .send(body)
      expect(first.status).toBe(CREATED)
      await owner.membership.update({
        where: { userId_storeId: { userId: solo.id, storeId: ctx.storeA2.id } },
        data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
      })
      const replay = await api(app, solo, ctx.storeA)
        .post(ApiRoutes.finance.transactions.record)
        .send(body)
      expect(replay.status).toBe(NOT_FOUND)
    })
  })

  describe('a member of both stores', () => {
    it('charges the sibling store once the membership is active, and not once it is suspended', async () => {
      const solo = await onlyFirstStore()
      // The same person in the second store; a custom role belongs to its own store, so the system role of an administrator carries them
      await ensureMembership(owner, {
        userId: solo.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      const asSolo = () => api(app, solo, ctx.storeA)

      const active = await asSolo()
        .post(ApiRoutes.finance.transactions.record)
        .send(expense({ storeId: ctx.storeA2.id }))
      expect(active.status).toBe(CREATED)

      await owner.membership.update({
        where: { userId_storeId: { userId: solo.id, storeId: ctx.storeA2.id } },
        data: { status: MembershipStatus.SUSPENDED }
      })
      const suspended = await asSolo()
        .post(ApiRoutes.finance.transactions.record)
        .send(expense({ storeId: ctx.storeA2.id }))
      expect(suspended.status).toBe(NOT_FOUND)

      await owner.membership.update({
        where: { userId_storeId: { userId: solo.id, storeId: ctx.storeA2.id } },
        data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
      })
      const revoked = await asSolo()
        .post(ApiRoutes.finance.transactions.record)
        .send(expense({ storeId: ctx.storeA2.id }))
      expect(revoked.status).toBe(NOT_FOUND)
    })
  })
})
