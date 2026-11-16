import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceConflicts,
  FinanceCountryCodes,
  FinanceTransactionKind,
  JournalEntryType,
  PeriodStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { day, postTestEntry } from '../builders/finance'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface TransactionBody {
  id: string
  kind: string
  occurredOn: string
  amountCents: number
  fromAccountId: string | null
  toAccountId: string | null
  categoryAccountId: string | null
  taxRateId: string | null
  taxCents: number
  taxCreditable: boolean
  documentNumber: string | null
  memo: string | null
  entryId: string
  voidedByEntryId: string | null
  voided: boolean
  replacesTransactionId: string | null
}
interface PageBody {
  data: TransactionBody[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const CASH = '1101'
const PETTY_CASH = '1102'
const BANK = '111001'
const INVENTORY = '1301'
const VAT_CREDIT = '1401'
const VAT_DEBIT = '2201'
const OTHER_INCOME = '4105'
const SERVICES = '6106'

const DAY_MS = 86_400_000
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)
// Far enough from the first and last day of a month that two days of a run never fall in two periods
const TODAY = isoDay(0)
const CLOSED_YEAR = 2020

describe('The expenses, incomes and transfers registered by hand (Step 4B.4)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let accountsB: Record<string, string> = {}
  let vatId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const actor of [asAdminA(), asAdminB()]) {
      const setup = await actor
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    accounts = await accountIds(ctx.orgA.id)
    accountsB = await accountIds(ctx.orgB.id)
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
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const key = (): string => `k${randomUUID().replaceAll('-', '')}`
  async function accountIds(organizationId: string): Promise<Record<string, string>> {
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId },
      select: { id: true, code: true }
    })
    return Object.fromEntries(rows.map(row => [row.code, row.id]))
  }
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

  const expense = (extra: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    kind: FinanceTransactionKind.EXPENSE,
    occurredOn: TODAY,
    amountCents: 11_300,
    fromAccountId: accounts[CASH],
    categoryAccountId: accounts[SERVICES],
    ...extra
  })
  const income = (extra: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    kind: FinanceTransactionKind.INCOME,
    occurredOn: TODAY,
    amountCents: 11_300,
    toAccountId: accounts[BANK],
    categoryAccountId: accounts[OTHER_INCOME],
    ...extra
  })
  const transfer = (extra: Record<string, unknown> = {}) => ({
    idempotencyKey: key(),
    kind: FinanceTransactionKind.TRANSFER,
    occurredOn: TODAY,
    amountCents: 5000,
    fromAccountId: accounts[CASH],
    toAccountId: accounts[BANK],
    ...extra
  })
  const record = (body: Record<string, unknown>) =>
    asAdminA().post(ApiRoutes.finance.transactions.record).send(body)
  async function registered(body: Record<string, unknown>): Promise<TransactionBody> {
    const response = await record(body)
    expect(response.status).toBe(CREATED)
    return response.body as TransactionBody
  }
  async function linesOf(entryId: string): Promise<[string, number, number][]> {
    const lines = await owner.journalLine.findMany({
      where: { entryId },
      orderBy: { lineNo: 'asc' },
      include: { account: { select: { code: true } } }
    })
    return lines.map(line => [line.account.code, line.debitCents, line.creditCents])
  }
  async function balanceOf(code: string): Promise<{ debit: number; credit: number }> {
    const sums = await owner.accountPeriodBalance.aggregate({
      where: { accountId: accounts[code] ?? '' },
      _sum: { debitCents: true, creditCents: true }
    })
    return {
      debit: Number(sums._sum.debitCents ?? 0n),
      credit: Number(sums._sum.creditCents ?? 0n)
    }
  }
  const journalCount = (organizationId: string): Promise<number> =>
    owner.journalEntry.count({ where: { organizationId } })

  describe('an expense', () => {
    it('posts the category against the source account, with the input VAT of a creditable document', async () => {
      const body = await registered(
        expense({
          taxRateId: vatId,
          taxCreditable: true,
          documentNumber: 'CCF-0001',
          memo: 'Internet'
        })
      )

      expect(body).toMatchObject({
        kind: 'expense',
        amountCents: 11_300,
        taxCents: 1300,
        taxCreditable: true,
        documentNumber: 'CCF-0001',
        memo: 'Internet',
        voided: false
      })
      expect(await linesOf(body.entryId)).toEqual([
        [SERVICES, 10_000, 0],
        [VAT_CREDIT, 1300, 0],
        [CASH, 0, 11_300]
      ])
      const entry = await owner.journalEntry.findUniqueOrThrow({ where: { id: body.entryId } })
      expect(entry).toMatchObject({
        type: JournalEntryType.EXPENSE,
        sourceType: 'finance_transaction',
        sourceId: body.id,
        totalCents: 11_300,
        createdBy: ctx.adminA.id,
        origin: 'user'
      })
    })

    it('books the whole amount to the category when the tax is not creditable', async () => {
      const body = await registered(expense({ taxRateId: vatId, taxCreditable: false }))

      // What the entry books as tax is nothing: the header says the same
      expect(body.taxCents).toBe(0)
      expect(await linesOf(body.entryId)).toEqual([
        [SERVICES, 11_300, 0],
        [CASH, 0, 11_300]
      ])
    })

    it('moves the balances of the accounts it names, by the amount', async () => {
      const before = { cash: await balanceOf(CASH), services: await balanceOf(SERVICES) }
      await registered(expense({ amountCents: 777 }))
      const after = { cash: await balanceOf(CASH), services: await balanceOf(SERVICES) }

      expect(after.cash.credit - before.cash.credit).toBe(777)
      expect(after.services.debit - before.services.debit).toBe(777)
    })

    it('carries the store it belongs to on every line, and refuses a store of another organization', async () => {
      const body = await registered(expense({ storeId: ctx.storeA2.id }))
      const lines = await owner.journalLine.findMany({ where: { entryId: body.entryId } })
      const foreign = await record(expense({ storeId: ctx.storeB.id }))

      expect(lines.map(line => line.storeId)).toEqual([ctx.storeA2.id, ctx.storeA2.id])
      expect(foreign.status).toBe(NOT_FOUND)
    })

    it('refuses what the rules of the books refuse, and writes nothing', async () => {
      const before = await journalCount(ctx.orgA.id)
      const cases: [string, Record<string, unknown>][] = [
        ['a source that is not a cash account', expense({ fromAccountId: accounts[INVENTORY] })],
        [
          'a category that is not an expense account',
          expense({ categoryAccountId: accounts[OTHER_INCOME] })
        ],
        ['no source', expense({ fromAccountId: undefined })],
        ['a destination', expense({ toAccountId: accounts[BANK] })],
        ['a creditable tax with no rate', expense({ taxCreditable: true })],
        ['a date in the future', expense({ occurredOn: isoDay(10) })]
      ]
      for (const [, body] of cases) {
        const response = await record(body)
        expect(response.status).toBe(BAD_REQUEST)
        expect(errorOf(response).code).toBe(ErrorCodes.VALIDATION_INVALID_INPUT)
      }
      expect(await journalCount(ctx.orgA.id)).toBe(before)
    })

    it('refuses a body the shape does not hold', async () => {
      for (const body of [
        expense({ amountCents: 0 }),
        expense({ amountCents: 1.5 }),
        expense({ amountCents: 2_147_483_648 }),
        expense({ occurredOn: '2026-02-31' }),
        expense({ idempotencyKey: 'short' }),
        expense({ unknown: true }),
        expense({ kind: 'sale' })
      ]) {
        expect((await record(body)).status).toBe(BAD_REQUEST)
      }
    })

    it('refuses an account that is switched off or only a header, with the typed answer', async () => {
      const header = await record(expense({ categoryAccountId: accounts['6'] }))
      const off = await owner.ledgerAccount.create({
        data: {
          organizationId: ctx.orgA.id,
          code: `X${randomUUID().slice(0, 6)}`,
          name: 'Switched off',
          type: 'expense',
          normalSide: 'debit',
          active: false
        }
      })
      const inactive = await record(expense({ categoryAccountId: off.id }))

      expect(header.status).toBe(CONFLICT)
      expect(errorOf(header).code).toBe(ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE)
      expect(errorOf(inactive).code).toBe(ErrorCodes.FINANCE_ACCOUNT_INACTIVE)
    })

    it('refuses a tax rate that is switched off', async () => {
      const off = await owner.taxRate.create({
        data: {
          organizationId: ctx.orgA.id,
          code: `O${randomUUID().slice(0, 6)}`,
          name: 'Off',
          rateBps: 500,
          outputAccountId: accounts[VAT_DEBIT] ?? '',
          inputAccountId: accounts[VAT_CREDIT] ?? '',
          active: false
        }
      })

      expect((await record(expense({ taxRateId: off.id }))).status).toBe(BAD_REQUEST)
    })
  })

  describe('an income', () => {
    it('posts the destination against the category and the output VAT', async () => {
      const body = await registered(income({ taxRateId: vatId }))

      expect(await linesOf(body.entryId)).toEqual([
        [BANK, 11_300, 0],
        [OTHER_INCOME, 0, 10_000],
        [VAT_DEBIT, 0, 1300]
      ])
      expect(body).toMatchObject({ kind: 'income', taxCents: 1300, taxCreditable: false })
    })

    it('posts the whole amount to the category when it carries no tax', async () => {
      const body = await registered(income())

      expect(await linesOf(body.entryId)).toEqual([
        [BANK, 11_300, 0],
        [OTHER_INCOME, 0, 11_300]
      ])
    })

    it('does not credit input VAT, and needs an income account as its category', async () => {
      expect((await record(income({ taxRateId: vatId, taxCreditable: true }))).status).toBe(
        BAD_REQUEST
      )
      expect((await record(income({ categoryAccountId: accounts[SERVICES] }))).status).toBe(
        BAD_REQUEST
      )
    })
  })

  describe('a transfer', () => {
    it('moves money between two distinct cash accounts, and takes no category and no tax', async () => {
      const body = await registered(transfer())

      expect(await linesOf(body.entryId)).toEqual([
        [BANK, 5000, 0],
        [CASH, 0, 5000]
      ])
      expect(body).toMatchObject({ kind: 'transfer', taxCents: 0, categoryAccountId: null })
      const entry = await owner.journalEntry.findUniqueOrThrow({ where: { id: body.entryId } })
      expect(entry.type).toBe(JournalEntryType.TRANSFER)
    })

    it('needs two distinct accounts that hold cash', async () => {
      for (const body of [
        transfer({ toAccountId: accounts[CASH] }),
        transfer({ toAccountId: accounts[INVENTORY] }),
        transfer({ fromAccountId: accounts[INVENTORY] }),
        transfer({ categoryAccountId: accounts[SERVICES] }),
        transfer({ taxRateId: vatId })
      ]) {
        expect((await record(body)).status).toBe(BAD_REQUEST)
      }
    })

    it('moves petty cash to the bank and back, and the balances follow', async () => {
      const before = { petty: await balanceOf(PETTY_CASH), bank: await balanceOf(BANK) }
      await registered(transfer({ fromAccountId: accounts[PETTY_CASH], amountCents: 321 }))
      const after = { petty: await balanceOf(PETTY_CASH), bank: await balanceOf(BANK) }

      expect(after.petty.credit - before.petty.credit).toBe(321)
      expect(after.bank.debit - before.bank.debit).toBe(321)
    })
  })

  describe('a retry', () => {
    it('finds the first request and writes nothing again', async () => {
      const body = expense({ amountCents: 4242 })
      const first = await record(body)
      const before = await journalCount(ctx.orgA.id)
      const second = await record(body)

      expect(first.status).toBe(CREATED)
      expect(second.status).toBe(CREATED)
      expect((second.body as TransactionBody).id).toBe((first.body as TransactionBody).id)
      expect(await journalCount(ctx.orgA.id)).toBe(before)
      expect(
        await owner.financeTransaction.count({ where: { clientKey: body.idempotencyKey } })
      ).toBe(1)
    })

    it('writes one transaction when the same request arrives many times at once', async () => {
      const body = expense({ amountCents: 4343 })
      const responses = await Promise.all([1, 2, 3, 4, 5].map(() => record(body)))

      expect(responses.map(response => response.status)).toEqual([201, 201, 201, 201, 201])
      expect(new Set(responses.map(response => (response.body as TransactionBody).id)).size).toBe(1)
      expect(
        await owner.financeTransaction.count({ where: { clientKey: body.idempotencyKey } })
      ).toBe(1)
    })

    it('refuses the key of another request, never overwriting the first', async () => {
      const body = expense({ amountCents: 4444 })
      await registered(body)
      const other = await record({ ...body, amountCents: 4445 })

      expect(other.status).toBe(CONFLICT)
      expect(errorOf(other).metadata?.conflict).toBe(FinanceConflicts.TRANSACTION_KEY_REUSED)
      expect(
        (
          await owner.financeTransaction.findFirstOrThrow({
            where: { clientKey: body.idempotencyKey }
          })
        ).amountCents
      ).toBe(4444)
    })
  })

  describe('voiding', () => {
    it('writes the reversing entry, points the transaction at it and puts the balances back', async () => {
      const before = await balanceOf(SERVICES)
      const body = await registered(expense({ amountCents: 900 }))
      const voided = await asAdminA()
        .post(ApiRoutes.finance.transactions.void(body.id))
        .send({ reason: 'Paid twice' })

      expect(voided.status).toBe(CREATED)
      const view = voided.body as TransactionBody
      expect(view).toMatchObject({ id: body.id, voided: true })
      const reversal = await owner.journalEntry.findUniqueOrThrow({
        where: { id: view.voidedByEntryId ?? '' }
      })
      expect(reversal).toMatchObject({
        reversesEntryId: body.entryId,
        type: JournalEntryType.REVERSAL,
        memo: 'Paid twice',
        createdBy: ctx.adminA.id
      })
      expect(await linesOf(reversal.id)).toEqual([
        [SERVICES, 0, 900],
        [CASH, 900, 0]
      ])
      const after = await balanceOf(SERVICES)
      expect(after.debit - before.debit).toBe(900)
      expect(after.credit - before.credit).toBe(900)
      // The original entry was never touched
      expect(await linesOf(body.entryId)).toEqual([
        [SERVICES, 900, 0],
        [CASH, 0, 900]
      ])
    })

    it('voids once: the second time is refused and writes nothing', async () => {
      const body = await registered(expense())
      const url = ApiRoutes.finance.transactions.void(body.id)
      expect((await asAdminA().post(url).send({ reason: 'Wrong' })).status).toBe(CREATED)
      const before = await journalCount(ctx.orgA.id)
      const again = await asAdminA().post(url).send({ reason: 'Wrong again' })

      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata?.conflict).toBe(FinanceConflicts.TRANSACTION_ALREADY_VOIDED)
      expect(await journalCount(ctx.orgA.id)).toBe(before)
    })

    it('voids once when two requests arrive at once', async () => {
      const body = await registered(expense())
      const url = ApiRoutes.finance.transactions.void(body.id)
      const responses = await Promise.all(
        [1, 2, 3].map(() => asAdminA().post(url).send({ reason: 'Race' }))
      )

      expect(responses.filter(response => response.status === CREATED)).toHaveLength(1)
      // The others are the typed refusal, never a 500 of a unique violation or a deadlock
      for (const response of responses.filter(each => each.status !== CREATED)) {
        expect(response.status).toBe(CONFLICT)
        expect(errorOf(response).metadata?.conflict).toBe(
          FinanceConflicts.TRANSACTION_ALREADY_VOIDED
        )
      }
      expect(await owner.journalEntry.count({ where: { reversesEntryId: body.entryId } })).toBe(1)
    })

    it('is not done by the generic reversal of the journal: the entry belongs to its transaction', async () => {
      const body = await registered(transfer())
      const before = await journalCount(ctx.orgA.id)
      const reversed = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(body.entryId))
        .send({ memo: 'Around the transaction' })

      expect(reversed.status).toBe(CONFLICT)
      expect(errorOf(reversed).metadata?.conflict).toBe(FinanceConflicts.ENTRY_OWNED_BY_TRANSACTION)
      expect(await journalCount(ctx.orgA.id)).toBe(before)
      expect(
        (await asAdminA().get(ApiRoutes.finance.transactions.byId(body.id))).body
      ).toMatchObject({
        voided: false
      })
    })

    it('says why, and an unknown transaction is a 404', async () => {
      const body = await registered(expense())

      expect(
        (await asAdminA().post(ApiRoutes.finance.transactions.void(body.id)).send({})).status
      ).toBe(BAD_REQUEST)
      expect(
        (
          await asAdminA()
            .post(ApiRoutes.finance.transactions.void(randomUUID()))
            .send({ reason: 'None' })
        ).status
      ).toBe(NOT_FOUND)
    })
  })

  describe('changing one', () => {
    it('voids it and registers the replacement in one request, linked to it', async () => {
      const body = await registered(expense({ amountCents: 1000 }))
      const changed = await asAdminA()
        .post(ApiRoutes.finance.transactions.replace(body.id))
        .send({ reason: 'Wrong amount', replacement: expense({ amountCents: 1100 }) })

      expect(changed.status).toBe(CREATED)
      const replacement = changed.body as TransactionBody
      expect(replacement).toMatchObject({
        amountCents: 1100,
        replacesTransactionId: body.id,
        voided: false
      })
      const original = await owner.financeTransaction.findUniqueOrThrow({ where: { id: body.id } })
      expect(original.voidedByEntryId).not.toBeNull()
    })

    it('changes nothing when the replacement is refused: the original stays whole', async () => {
      const body = await registered(expense({ amountCents: 1200 }))
      const before = await journalCount(ctx.orgA.id)
      const changed = await asAdminA()
        .post(ApiRoutes.finance.transactions.replace(body.id))
        .send({ reason: 'Bad', replacement: expense({ fromAccountId: accounts[INVENTORY] }) })

      expect(changed.status).toBe(BAD_REQUEST)
      expect(await journalCount(ctx.orgA.id)).toBe(before)
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: body.id } }))
          .voidedByEntryId
      ).toBeNull()
    })

    it('keeps the kind, and cannot change a transaction already voided', async () => {
      const body = await registered(expense())
      const kind = await asAdminA()
        .post(ApiRoutes.finance.transactions.replace(body.id))
        .send({ reason: 'Kind', replacement: transfer() })
      const voided = await asAdminA()
        .post(ApiRoutes.finance.transactions.void(body.id))
        .send({ reason: 'Gone' })
      const again = await asAdminA()
        .post(ApiRoutes.finance.transactions.replace(body.id))
        .send({ reason: 'Late', replacement: expense() })

      expect(kind.status).toBe(CONFLICT)
      expect(errorOf(kind).metadata?.conflict).toBe(FinanceConflicts.TRANSACTION_KIND_CHANGED)
      expect(voided.status).toBe(CREATED)
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata?.conflict).toBe(FinanceConflicts.TRANSACTION_ALREADY_VOIDED)
    })

    it('answers a retry with the replacement the first request made, and voids nothing twice', async () => {
      const body = await registered(expense({ amountCents: 1300 }))
      const request = { reason: 'Retry', replacement: expense({ amountCents: 1400 }) }
      const url = ApiRoutes.finance.transactions.replace(body.id)
      const first = await asAdminA().post(url).send(request)
      const before = await journalCount(ctx.orgA.id)
      const second = await asAdminA().post(url).send(request)

      expect(second.status).toBe(CREATED)
      expect((second.body as TransactionBody).id).toBe((first.body as TransactionBody).id)
      expect(await journalCount(ctx.orgA.id)).toBe(before)
    })

    it('voids and replaces once when several changes of the same transaction arrive at once', async () => {
      const body = await registered(expense({ amountCents: 1500 }))
      const url = ApiRoutes.finance.transactions.replace(body.id)
      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          asAdminA()
            .post(url)
            .send({ reason: 'Race', replacement: expense({ amountCents: 1600 }) })
        )
      )

      expect(responses.filter(response => response.status === CREATED)).toHaveLength(1)
      for (const response of responses.filter(each => each.status !== CREATED)) {
        expect(response.status).toBe(CONFLICT)
      }
      expect(await owner.journalEntry.count({ where: { reversesEntryId: body.entryId } })).toBe(1)
      expect(
        await owner.financeTransaction.count({ where: { replacesTransactionId: body.id } })
      ).toBe(1)
    })

    it('voids once when a change and a plain void of the same transaction arrive at once', async () => {
      const body = await registered(expense({ amountCents: 1700 }))
      const responses = await Promise.all([
        asAdminA()
          .post(ApiRoutes.finance.transactions.replace(body.id))
          .send({ reason: 'Change', replacement: expense({ amountCents: 1800 }) }),
        asAdminA().post(ApiRoutes.finance.transactions.void(body.id)).send({ reason: 'Void' })
      ])

      expect(responses.filter(response => response.status === CREATED)).toHaveLength(1)
      const refused = responses.filter(response => response.status === CONFLICT)
      expect(refused).toHaveLength(1)
      // The typed refusal of the route, even though the two asked for the void with other reasons
      expect(errorOf(refused[0] ?? { body: {} }).metadata?.conflict).toBe(
        FinanceConflicts.TRANSACTION_ALREADY_VOIDED
      )
      expect(await owner.journalEntry.count({ where: { reversesEntryId: body.entryId } })).toBe(1)
    })

    it('refuses a replacement key that belongs to another transaction', async () => {
      const first = await registered(expense())
      const other = await registered(expense())
      const replacement = expense()
      await asAdminA()
        .post(ApiRoutes.finance.transactions.replace(first.id))
        .send({ reason: 'One', replacement })
      const stolen = await asAdminA()
        .post(ApiRoutes.finance.transactions.replace(other.id))
        .send({ reason: 'Two', replacement })

      expect(stolen.status).toBe(CONFLICT)
      expect(errorOf(stolen).metadata?.conflict).toBe(FinanceConflicts.TRANSACTION_KEY_REUSED)
    })
  })

  describe('a closed period', () => {
    let closedMonthDay = ''
    let transactionInClosed: TransactionBody

    beforeAll(async () => {
      // A month of an old year, written before it was closed and then closed with its lock, for organization B
      closedMonthDay = `${CLOSED_YEAR}-01-15`
      const accountsOfB = accountsB
      transactionInClosed = (
        await asAdminB()
          .post(ApiRoutes.finance.transactions.record)
          .send({
            idempotencyKey: key(),
            kind: FinanceTransactionKind.EXPENSE,
            occurredOn: closedMonthDay,
            amountCents: 600,
            fromAccountId: accountsOfB[CASH],
            categoryAccountId: accountsOfB[SERVICES]
          })
          .expect(CREATED)
      ).body as TransactionBody
      const period = await owner.fiscalPeriod.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, year: CLOSED_YEAR, month: 1 }
      })
      await owner.fiscalPeriod.update({
        where: { id: period.id },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: 'the-closer' }
      })
      await owner.financeSettings.update({
        where: { organizationId: ctx.orgB.id },
        data: { lockedThrough: day(`${CLOSED_YEAR}-01-31`) }
      })
    })

    it('takes no transaction dated in it and writes nothing', async () => {
      const before = await journalCount(ctx.orgB.id)
      const response = await asAdminB()
        .post(ApiRoutes.finance.transactions.record)
        .send({
          idempotencyKey: key(),
          kind: FinanceTransactionKind.EXPENSE,
          occurredOn: `${CLOSED_YEAR}-01-20`,
          amountCents: 600,
          fromAccountId: accountsB[CASH],
          categoryAccountId: accountsB[SERVICES]
        })

      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
      expect(await journalCount(ctx.orgB.id)).toBe(before)
    })

    it('voids a transaction of the closed period in the open one, and the closed month does not change', async () => {
      const voided = await asAdminB()
        .post(ApiRoutes.finance.transactions.void(transactionInClosed.id))
        .send({ reason: 'Late correction' })

      expect(voided.status).toBe(CREATED)
      const reversal = await owner.journalEntry.findUniqueOrThrow({
        where: { id: (voided.body as TransactionBody).voidedByEntryId ?? '' }
      })
      expect(reversal.entryDate.toISOString().slice(0, 10)).toBe(`${CLOSED_YEAR}-02-01`)
    })
  })

  describe('the permissions', () => {
    it('lets a bookkeeper with manage_transactions register an expense and an income, and not a transfer', async () => {
      const bookkeeper = await asRole('bookkeeper', [Permissions.FINANCE_MANAGE_TRANSACTIONS])
      const send = (body: Record<string, unknown>) =>
        bookkeeper.post(ApiRoutes.finance.transactions.record).send(body)

      expect((await send(expense())).status).toBe(CREATED)
      expect((await send(income())).status).toBe(CREATED)
      const refused = await send(transfer())
      expect(refused.status).toBe(FORBIDDEN)
      expect(errorOf(refused).code).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it('lets a treasurer with move_money register a transfer, and not an expense or an income', async () => {
      const treasurer = await asRole('treasurer', [Permissions.FINANCE_MOVE_MONEY])
      const send = (body: Record<string, unknown>) =>
        treasurer.post(ApiRoutes.finance.transactions.record).send(body)

      expect((await send(transfer())).status).toBe(CREATED)
      expect((await send(expense())).status).toBe(FORBIDDEN)
      expect((await send(income())).status).toBe(FORBIDDEN)
    })

    it('voids and changes only what the permission of the kind allows', async () => {
      const bookkeeper = await asRole('bookkeeper-void', [Permissions.FINANCE_MANAGE_TRANSACTIONS])
      const treasurer = await asRole('treasurer-void', [Permissions.FINANCE_MOVE_MONEY])
      const moved = await registered(transfer())
      const spent = await registered(expense())
      const voidBody = { reason: 'No' }
      const before = await journalCount(ctx.orgA.id)

      expect(
        (await bookkeeper.post(ApiRoutes.finance.transactions.void(moved.id)).send(voidBody)).status
      ).toBe(FORBIDDEN)
      expect(
        (
          await bookkeeper
            .post(ApiRoutes.finance.transactions.replace(moved.id))
            .send({ reason: 'No', replacement: transfer() })
        ).status
      ).toBe(FORBIDDEN)
      expect(
        (await treasurer.post(ApiRoutes.finance.transactions.void(spent.id)).send(voidBody)).status
      ).toBe(FORBIDDEN)
      expect(await journalCount(ctx.orgA.id)).toBe(before)
      expect(
        (await bookkeeper.post(ApiRoutes.finance.transactions.void(spent.id)).send(voidBody)).status
      ).toBe(CREATED)
      expect(
        (await treasurer.post(ApiRoutes.finance.transactions.void(moved.id)).send(voidBody)).status
      ).toBe(CREATED)
    })

    it('reads with the journal permission and writes with neither of the two others', async () => {
      const viewer = await asRole('finance-viewer', [Permissions.FINANCE_VIEW])
      const reader = await asRole('journal-reader', [Permissions.FINANCE_VIEW_JOURNAL])
      const body = await registered(expense())

      expect((await viewer.get(ApiRoutes.finance.transactions.list)).status).toBe(FORBIDDEN)
      expect((await viewer.get(ApiRoutes.finance.transactions.byId(body.id))).status).toBe(
        FORBIDDEN
      )
      expect((await reader.get(ApiRoutes.finance.transactions.list)).status).toBe(OK)
      expect((await reader.get(ApiRoutes.finance.transactions.byId(body.id))).status).toBe(OK)
      expect(
        (await reader.post(ApiRoutes.finance.transactions.record).send(expense())).status
      ).toBe(FORBIDDEN)
      expect(
        (await viewer.post(ApiRoutes.finance.transactions.record).send(expense())).status
      ).toBe(FORBIDDEN)
    })

    it('does not let the permission of a store reach another organization', async () => {
      const response = await asAdminB().post(ApiRoutes.finance.transactions.record).send(expense())

      // The accounts are A's: for B they do not exist
      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('reading', () => {
    it('lists the newest first, by page, and hides the voided unless asked', async () => {
      const kept = await registered(expense({ amountCents: 51 }))
      const gone = await registered(expense({ amountCents: 52 }))
      await asAdminA().post(ApiRoutes.finance.transactions.void(gone.id)).send({ reason: 'Gone' })

      const page = await asAdminA().get(`${ApiRoutes.finance.transactions.list}?limit=2`)
      const all = await asAdminA().get(
        `${ApiRoutes.finance.transactions.list}?includeVoided=true&limit=100`
      )
      const next = (page.body as PageBody).nextCursor

      expect(page.status).toBe(OK)
      expect((page.body as PageBody).data).toHaveLength(2)
      expect(next).not.toBeNull()
      expect((page.body as PageBody).data.some(row => row.id === gone.id)).toBe(false)
      expect((page.body as PageBody).data[0]?.id).toBe(kept.id)
      expect((all.body as PageBody).data.some(row => row.id === gone.id)).toBe(true)
      const second = await asAdminA().get(
        `${ApiRoutes.finance.transactions.list}?limit=2&cursor=${next ?? ''}`
      )
      expect(second.status).toBe(OK)
    })

    it('filters by kind, by date and by account', async () => {
      const moved = await registered(
        transfer({ fromAccountId: accounts[PETTY_CASH], amountCents: 61 })
      )
      const byKind = await asAdminA().get(`${ApiRoutes.finance.transactions.list}?kind=transfer`)
      const byAccount = await asAdminA().get(
        `${ApiRoutes.finance.transactions.list}?accountId=${accounts[PETTY_CASH] ?? ''}`
      )
      const byDate = await asAdminA().get(
        `${ApiRoutes.finance.transactions.list}?from=${isoDay(-3000)}&to=${isoDay(-2999)}`
      )

      expect((byKind.body as PageBody).data.every(row => row.kind === 'transfer')).toBe(true)
      expect((byAccount.body as PageBody).data.some(row => row.id === moved.id)).toBe(true)
      expect((byDate.body as PageBody).data).toEqual([])
    })
  })

  describe('another organization', () => {
    it('cannot read, list, void or replace a transaction of this one, and sees none of its rows', async () => {
      const body = await registered(expense({ amountCents: 71 }))
      const asB = asAdminB()
      const list = await asB.get(
        `${ApiRoutes.finance.transactions.list}?includeVoided=true&limit=100`
      )

      expect((await asB.get(ApiRoutes.finance.transactions.byId(body.id))).status).toBe(NOT_FOUND)
      expect(
        (await asB.post(ApiRoutes.finance.transactions.void(body.id)).send({ reason: 'x' })).status
      ).toBe(NOT_FOUND)
      expect(
        (
          await asB.post(ApiRoutes.finance.transactions.replace(body.id)).send({
            reason: 'x',
            replacement: {
              idempotencyKey: key(),
              kind: 'expense',
              occurredOn: TODAY,
              amountCents: 5,
              fromAccountId: accountsB[CASH],
              categoryAccountId: accountsB[SERVICES]
            }
          })
        ).status
      ).toBe(NOT_FOUND)
      expect((list.body as PageBody).data.some(row => row.id === body.id)).toBe(false)
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: body.id } }))
          .voidedByEntryId
      ).toBeNull()
    })

    it('cannot register against the accounts, the rate or the store of this one', async () => {
      const asB = asAdminB()
      const send = (extra: Record<string, unknown>) =>
        asB.post(ApiRoutes.finance.transactions.record).send({
          idempotencyKey: key(),
          kind: 'expense',
          occurredOn: TODAY,
          amountCents: 5,
          fromAccountId: accountsB[CASH],
          categoryAccountId: accountsB[SERVICES],
          ...extra
        })

      expect((await send({ fromAccountId: accounts[CASH] })).status).toBe(NOT_FOUND)
      expect((await send({ categoryAccountId: accounts[SERVICES] })).status).toBe(NOT_FOUND)
      expect((await send({ taxRateId: vatId })).status).toBe(NOT_FOUND)
      expect((await send({ storeId: ctx.storeA.id })).status).toBe(NOT_FOUND)
      expect((await send({})).status).toBe(CREATED)
    })

    it('reads the key of its own organization: the same key in two organizations is two requests', async () => {
      const sharedKey = key()
      const a = await record(expense({ idempotencyKey: sharedKey }))
      const b = await asAdminB().post(ApiRoutes.finance.transactions.record).send({
        idempotencyKey: sharedKey,
        kind: 'expense',
        occurredOn: TODAY,
        amountCents: 5,
        fromAccountId: accountsB[CASH],
        categoryAccountId: accountsB[SERVICES]
      })

      expect(a.status).toBe(CREATED)
      expect(b.status).toBe(CREATED)
      expect((a.body as TransactionBody).id).not.toBe((b.body as TransactionBody).id)
    })
  })

  describe('the audit', () => {
    it('records who registered and who voided, with no free text of the person', async () => {
      const body = await registered(expense({ memo: 'secret supplier note' }))
      await asAdminA()
        .post(ApiRoutes.finance.transactions.void(body.id))
        .send({ reason: 'secret reason' })

      const [recorded] = await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_TRANSACTION_RECORDED,
        resourceId: body.id
      })
      const [voided] = await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_TRANSACTION_VOIDED,
        resourceId: body.id
      })

      expect(recorded).toMatchObject({ userId: ctx.adminA.id, organizationId: ctx.orgA.id })
      expect(recorded?.metadata).toMatchObject({ kind: 'expense', amountCents: 11_300 })
      expect(voided).toMatchObject({ userId: ctx.adminA.id })
      expect(JSON.stringify([recorded?.metadata, voided?.metadata])).not.toContain('secret')
    })

    it('records nothing for a retry that found the first request', async () => {
      const body = expense()
      const first = await registered(body)
      await record(body)
      await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_TRANSACTION_RECORDED,
        resourceId: first.id
      })

      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.FINANCE_TRANSACTION_RECORDED, resourceId: first.id }
        })
      ).toBe(1)
    })
  })

  describe('the database, whoever writes', () => {
    // A header with ITS OWN entry (the entry of the same type, source, total and date), so that what a case trips on is the rule it
    // names and not the entry that does not fit
    async function ownEntryFor(kind: string, id: string, cents: number): Promise<string> {
      const period = await owner.fiscalPeriod.findFirstOrThrow({
        where: {
          organizationId: ctx.orgA.id,
          startsOn: { lte: day(TODAY) },
          endsOn: { gte: day(TODAY) }
        }
      })
      const entry = await postTestEntry(owner, {
        organizationId: ctx.orgA.id,
        periodId: period.id,
        entryDate: TODAY,
        type: kind as JournalEntryType,
        sourceType: 'finance_transaction',
        sourceId: id,
        lines: [
          { accountId: accounts[SERVICES] ?? '', debitCents: cents },
          { accountId: accounts[CASH] ?? '', creditCents: cents }
        ]
      })
      return entry.id
    }
    const rowData = async (extra: Record<string, unknown> = {}) => {
      const id = randomUUID()
      const kind = (extra['kind'] as string | undefined) ?? 'expense'
      const amountCents = (extra['amountCents'] as number | undefined) ?? 91
      return {
        id,
        organizationId: ctx.orgA.id,
        kind,
        occurredOn: day(TODAY),
        amountCents,
        fromAccountId: accounts[CASH] ?? '',
        categoryAccountId: accounts[SERVICES] ?? '',
        clientKey: key(),
        entryId: await ownEntryFor(kind, id, Math.max(amountCents, 1)),
        createdBy: ctx.adminA.id,
        ...extra
      }
    }
    const insertRow = async (extra: Record<string, unknown> = {}) =>
      owner.financeTransaction.create({ data: await rowData(extra) })
    // The CHECKs alone: the trigger is switched off inside a transaction that is rolled back, so the CHECK is what refuses
    async function insertWithoutTrigger(extra: Record<string, unknown>): Promise<void> {
      const data = await rowData(extra)
      // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
      await owner.$transaction(async tx => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE finance_transactions DISABLE TRIGGER trg_finance_transactions_check'
        )
        await tx.financeTransaction.create({ data })
      })
    }

    it('holds the shape of each kind with CHECKs, whatever the trigger says', async () => {
      const cases: [string, Record<string, unknown>][] = [
        ['amount', { amountCents: 0 }],
        ['shape', { kind: 'transfer' }],
        ['shape', { toAccountId: accounts[BANK] ?? '' }],
        ['shape', { fromAccountId: null }],
        ['tax', { taxCents: 91 }],
        ['tax_rate', { taxCents: 5 }],
        ['creditable', { taxCreditable: true }],
        ['client_key', { clientKey: '' }],
        ['kind', { kind: 'sale' }]
      ]
      for (const [name, extra] of cases) {
        await expect(insertWithoutTrigger(extra)).rejects.toThrow(
          new RegExp(`chk_finance_transactions_${name}|check constraint`, 'i')
        )
      }
    })

    it('names only cash accounts as the money, and a category of the type of its kind', async () => {
      await expect(insertRow({ fromAccountId: accounts[INVENTORY] ?? '' })).rejects.toThrow(
        /FINANCE_TRANSACTION_ACCOUNT/
      )
      await expect(insertRow({ categoryAccountId: accounts[OTHER_INCOME] ?? '' })).rejects.toThrow(
        /FINANCE_TRANSACTION_ACCOUNT/
      )
      await expect(
        insertRow({
          toAccountId: accounts[INVENTORY] ?? '',
          kind: 'income',
          fromAccountId: null,
          categoryAccountId: accounts[OTHER_INCOME] ?? ''
        })
      ).rejects.toThrow(/FINANCE_TRANSACTION_ACCOUNT/)
      // A valid row of the same helper is accepted: what is refused above is the account, not the helper
      await expect(insertRow()).resolves.toBeDefined()
    })

    it('refuses an entry that is not the one the transaction posts', async () => {
      const other = await registered(expense({ amountCents: 92 }))

      // The entry of another transaction: the source of the entry is not this row
      await expect(insertRow({ entryId: other.entryId })).rejects.toThrow(
        /FINANCE_TRANSACTION_ENTRY/
      )
      // An entry of another amount
      await expect(
        owner.financeTransaction.create({ data: { ...(await rowData()), amountCents: 92 } })
      ).rejects.toThrow(/FINANCE_TRANSACTION_ENTRY/)
    })

    it('is born live, and replaces only a voided transaction of its own kind', async () => {
      const live = await registered(expense({ amountCents: 94 }))
      const other = await registered(expense({ amountCents: 95 }))
      await asAdminA().post(ApiRoutes.finance.transactions.void(other.id)).send({ reason: 'Gone' })
      const voided = await owner.financeTransaction.findUniqueOrThrow({ where: { id: other.id } })

      await expect(insertRow({ voidedByEntryId: voided.voidedByEntryId })).rejects.toThrow(
        /FINANCE_TRANSACTION_IMMUTABLE/
      )
      // A live transaction is not replaced, and neither is one of another kind
      await expect(insertRow({ replacesTransactionId: live.id })).rejects.toThrow(
        /FINANCE_TRANSACTION_ENTRY/
      )
      const moved = await registered(transfer())
      await asAdminA().post(ApiRoutes.finance.transactions.void(moved.id)).send({ reason: 'Gone' })
      await expect(insertRow({ replacesTransactionId: moved.id })).rejects.toThrow(
        /FINANCE_TRANSACTION_ENTRY/
      )
      // What a voided transaction of its own kind replaces is accepted
      await expect(insertRow({ replacesTransactionId: other.id })).resolves.toBeDefined()
    })

    it('never changes or deletes a transaction, the owner of the table included', async () => {
      const body = await registered(expense({ amountCents: 93 }))

      await expect(
        owner.financeTransaction.update({ where: { id: body.id }, data: { amountCents: 1 } })
      ).rejects.toThrow(/FINANCE_TRANSACTION_IMMUTABLE/)
      await expect(
        owner.financeTransaction.update({ where: { id: body.id }, data: { memo: 'changed' } })
      ).rejects.toThrow(/FINANCE_TRANSACTION_IMMUTABLE/)
      await expect(
        owner.financeTransaction.update({
          where: { id: body.id },
          data: { voidedByEntryId: body.entryId }
        })
      ).rejects.toThrow(/FINANCE_TRANSACTION_/)
      await expect(owner.financeTransaction.delete({ where: { id: body.id } })).rejects.toThrow(
        /FINANCE_TRANSACTION_IMMUTABLE/
      )
      expect(
        (await owner.financeTransaction.findUniqueOrThrow({ where: { id: body.id } })).amountCents
      ).toBe(93)
    })
  })
})
