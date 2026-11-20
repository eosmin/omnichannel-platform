import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinanceReportLimits,
  JournalEntryType,
  PartyType,
  PeriodStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type ChainEntry, verifyChain } from '@platform/core/finance-hash'

import { tamperWithLedger } from '../builders/finance'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface PeriodBody {
  id: string
  year: number
  month: number
  status: string
  closingHash: string | null
  closedAt: string | null
  closedBy: string | null
  reopenedAt: string | null
  reopenedBy: string | null
  reopenReason: string | null
}
interface EntryBody {
  id: string
  hash: string
}
interface TrialBody {
  rows: { code: string; debitCents: string; creditCents: string; balanceCents: string }[]
  totals: { debitCents: string; creditCents: string; balanced: boolean }
}
interface AccountBalancesBody {
  rows: { accountId: string; cashKind: string | null; balanceCents: string }[]
  totals: { debitCents: string; creditCents: string; balanced: boolean | null }
}
interface JournalBody {
  data: { hash: string; lines: { debitCents: number; creditCents: number }[] }[]
  nextCursor: string | null
  hasMore: boolean
}
interface LedgerBody {
  openingCents: string
  lines: { runningCents: string; debitCents: string; creditCents: string }[]
  hasMore: boolean
  nextCursor: string | null
}
interface ChainBody {
  ok: boolean
  entriesChecked: number
  headNumber: string | null
  break: { reason: string; number: string } | null
  frozenHeads: { present: boolean }[]
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const START = '2026-01-01'
const CASH = '1101'
const RENT = '6105'

describe('Closing the months, the reports and the auditor files', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accountsA: Record<string, string> = {}
  let accountsB: Record<string, string> = {}

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const key = (): string => `k-${randomUUID()}`
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
  const body = (
    accounts: Record<string, string>,
    entryDate: string,
    cents: number,
    memo = 'Entry of the suite'
  ) => ({
    idempotencyKey: key(),
    entryDate,
    type: JournalEntryType.MANUAL,
    memo,
    lines: [
      { accountId: accounts[RENT], debitCents: cents },
      { accountId: accounts[CASH], creditCents: cents }
    ]
  })
  async function post(
    agent: () => ReturnType<typeof asAdminA>,
    accounts: Record<string, string>,
    entryDate: string,
    cents: number,
    memo?: string
  ): Promise<EntryBody> {
    const response = await agent()
      .post(ApiRoutes.finance.entries.manual)
      .send(body(accounts, entryDate, cents, memo))
    expect(response.status).toBe(CREATED)
    return response.body as EntryBody
  }
  async function periodOf(organizationId: string, year: number, month: number) {
    return owner.fiscalPeriod.findFirstOrThrow({ where: { organizationId, year, month } })
  }
  async function setUp(agent: () => ReturnType<typeof asAdminA>): Promise<void> {
    const response = await agent()
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
    expect(response.status).toBe(CREATED)
  }

  let january: PeriodBody
  const janHashes: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    await setUp(asAdminA)
    await setUp(asAdminB)
    accountsA = await accountIds(ctx.orgA.id)
    accountsB = await accountIds(ctx.orgB.id)
    // January first (the numbers 1 to 3), so the file of January starts the chain; February after it
    for (const cents of [1_000, 250, 75]) {
      janHashes.push((await post(asAdminA, accountsA, '2026-01-15', cents)).hash)
    }
    await post(asAdminA, accountsA, '2026-02-10', 40)
    const row = await periodOf(ctx.orgA.id, 2026, 1)
    january = { ...(row as unknown as PeriodBody) }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  describe('the body and the query of a close and of the chain status', () => {
    it('refuses an organizationId, as every other route of the finance does (LED-753)', async () => {
      const february = await periodOf(ctx.orgA.id, 2026, 2)

      const close = await asAdminA()
        .post(ApiRoutes.finance.periods.close(february.id))
        .send({ organizationId: ctx.orgB.id })
      const status = await asAdminA().get(
        `${ApiRoutes.finance.reports.chainStatus}?organizationId=${ctx.orgB.id}`
      )

      expect(close.status).toBe(BAD_REQUEST)
      expect(status.status).toBe(BAD_REQUEST)
      expect((await periodOf(ctx.orgA.id, 2026, 2)).status).toBe(PeriodStatus.OPEN)
    })
  })

  describe('the preconditions of a close', () => {
    it('closes in order: February waits for January', async () => {
      const february = await periodOf(ctx.orgA.id, 2026, 2)

      const response = await asAdminA().post(ApiRoutes.finance.periods.close(february.id)).send({})

      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_CLOSE_PREVIOUS_OPEN)
    })

    it('refuses with a posting that failed and has not been resolved, and closes once it is', async () => {
      const failure = await owner.financePostingFailure.create({
        data: {
          organizationId: ctx.orgA.id,
          sourceType: 'order',
          sourceId: randomUUID(),
          eventKind: 'sale',
          reason: 'role_not_mapped'
        }
      })

      const refused = await asAdminA().post(ApiRoutes.finance.periods.close(january.id)).send({})
      await owner.financePostingFailure.update({
        where: { id: failure.id },
        data: { resolvedAt: new Date() }
      })

      expect(errorOf(refused).code).toBe(ErrorCodes.FINANCE_CLOSE_PENDING_POSTINGS)
      expect(errorOf(refused).metadata).toMatchObject({
        failureCount: 1,
        failures: [{ reason: 'role_not_mapped', count: 1 }],
        pendingSources: 0,
        truncated: false
      })
      expect((await periodOf(ctx.orgA.id, 2026, 1)).status).toBe(PeriodStatus.OPEN)
    })

    it('closes once when two people close it at the same time', async () => {
      const [x, y] = await Promise.all([
        asAdminA().post(ApiRoutes.finance.periods.close(january.id)).send({}),
        asAdminA().post(ApiRoutes.finance.periods.close(january.id)).send({})
      ])

      expect([x.status, y.status].sort()).toEqual([OK, CONFLICT].sort())
      expect(
        [x, y]
          .filter(response => response.status === CONFLICT)
          .map(response => errorOf(response).code)
      ).toEqual([ErrorCodes.FINANCE_PERIOD_ALREADY_CLOSED])
      await asAdminA()
        .post(ApiRoutes.finance.periods.reopen(january.id))
        .send({ reason: 'Back to open after the race test' })
    })

    it('refuses a period of another organization as it would one that does not exist', async () => {
      const response = await asAdminB().post(ApiRoutes.finance.periods.close(january.id)).send({})

      expect(response.status).toBe(NOT_FOUND)
      expect((await periodOf(ctx.orgA.id, 2026, 1)).status).toBe(PeriodStatus.OPEN)
    })

    it('refuses a role that holds anything but finance:close_periods', async () => {
      const bookkeeper = await asRole('bookkeeper', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_POST_MANUAL,
        Permissions.FINANCE_EXPORT
      ])

      const close = await bookkeeper.post(ApiRoutes.finance.periods.close(january.id)).send({})
      const reopen = await bookkeeper
        .post(ApiRoutes.finance.periods.reopen(january.id))
        .send({ reason: 'no' })

      expect([close.status, reopen.status]).toEqual([FORBIDDEN, FORBIDDEN])
    })
  })

  describe('closing January', () => {
    let trialBefore: TrialBody

    beforeAll(async () => {
      const response = await asAdminA().get(ApiRoutes.finance.reports.trialBalance).query({
        periodId: january.id
      })
      trialBefore = response.body as TrialBody
    })

    it('closes it, freezes the head of the chain and locks the books through its last day', async () => {
      const response = await asAdminA().post(ApiRoutes.finance.periods.close(january.id)).send({})

      expect(response.status).toBe(OK)
      const closed = response.body as PeriodBody
      expect(closed.status).toBe(PeriodStatus.CLOSED)
      expect(closed.closedBy).toBe(ctx.adminA.id)
      const row = await periodOf(ctx.orgA.id, 2026, 1)
      // The head when it closed: the third entry, the last of January (February was written after it by the beforeAll, so the head
      // is the fourth; the period keeps the head of the chain at the moment of the close)
      const head = await owner.financeSettings.findUniqueOrThrow({
        where: { organizationId: ctx.orgA.id }
      })
      expect(row.closingHash).toBe(head.lastEntryHash)
      // The head that was frozen is what the auditor reads (TDD_18 §5.1), in the answer of the close, of one period and of the list
      expect(closed.closingHash).toBe(row.closingHash)
      const one = await asAdminA().get(ApiRoutes.finance.periods.byId(january.id))
      expect((one.body as PeriodBody).closingHash).toBe(row.closingHash)
      const list = await asAdminA().get(ApiRoutes.finance.periods.list)
      const listed = (list.body as { data: PeriodBody[] }).data.find(item => item.id === january.id)
      expect(listed?.closingHash).toBe(row.closingHash)
      expect(head.lockedThrough?.toISOString().slice(0, 10)).toBe('2026-01-31')
      const audit = await waitForAuditEntries(
        owner,
        {
          organizationId: ctx.orgA.id,
          action: AuditAction.FINANCE_PERIOD_CLOSED,
          resourceId: january.id
        },
        2
      )
      // The close of the race test and this one: each leaves its own row
      expect(audit).toHaveLength(2)
    })

    it('says so again as a conflict, and writes nothing', async () => {
      const response = await asAdminA().post(ApiRoutes.finance.periods.close(january.id)).send({})

      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_PERIOD_ALREADY_CLOSED)
    })

    it('takes no entry dated in it, and its trial balance does not move when a late entry is posted in February', async () => {
      const refused = await asAdminA()
        .post(ApiRoutes.finance.entries.manual)
        .send(body(accountsA, '2026-01-20', 5))
      await post(asAdminA, accountsA, '2026-02-12', 5)

      const after = await asAdminA()
        .get(ApiRoutes.finance.reports.trialBalance)
        .query({ periodId: january.id })

      expect(errorOf(refused).code).toBe(ErrorCodes.FINANCE_PERIOD_CLOSED)
      expect(after.body).toEqual(trialBefore)
      expect(trialBefore.totals.balanced).toBe(true)
    })

    it('reopens only the latest closed month, with the reason, and says who and when', async () => {
      const february = await periodOf(ctx.orgA.id, 2026, 2)
      await asAdminA().post(ApiRoutes.finance.periods.close(february.id)).send({})
      const refused = await asAdminA()
        .post(ApiRoutes.finance.periods.reopen(january.id))
        .send({ reason: 'A correction' })
      const noReason = await asAdminA()
        .post(ApiRoutes.finance.periods.reopen(february.id))
        .send({ reason: '   ' })
      const open = await asAdminA()
        .post(ApiRoutes.finance.periods.reopen(february.id))
        .send({ reason: 'The bank corrected a payment' })

      expect(errorOf(refused).code).toBe(ErrorCodes.FINANCE_REOPEN_NOT_LATEST)
      expect(noReason.status).toBe(BAD_REQUEST)
      expect(open.status).toBe(OK)
      expect(open.body).toMatchObject({
        status: PeriodStatus.OPEN,
        reopenedBy: ctx.adminA.id,
        reopenReason: 'The bank corrected a payment',
        // The head of the last close is not offered for a month that can change again
        closingHash: null,
        // February 2026 is over in the day of every store: the api says so, the button of the screen follows it
        hasEnded: true,
        hasStarted: true
      })
      expect((open.body as PeriodBody).reopenedAt).not.toBeNull()
      const settings = await owner.financeSettings.findUniqueOrThrow({
        where: { organizationId: ctx.orgA.id }
      })
      expect(settings.lockedThrough?.toISOString().slice(0, 10)).toBe('2026-01-31')
      const again = await asAdminA()
        .post(ApiRoutes.finance.periods.reopen(february.id))
        .send({ reason: 'Twice' })
      expect(errorOf(again).code).toBe(ErrorCodes.FINANCE_PERIOD_NOT_CLOSED)
      const audit = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_PERIOD_REOPENED,
        resourceId: february.id
      })
      expect(audit[0]?.metadata).toMatchObject({ reason: 'The bank corrected a payment' })
    })

    it('closes it again later and freezes the head it has then', async () => {
      const february = await periodOf(ctx.orgA.id, 2026, 2)
      const first = await owner.fiscalPeriod.findUniqueOrThrow({ where: { id: february.id } })
      await post(asAdminA, accountsA, '2026-02-20', 9)

      const response = await asAdminA().post(ApiRoutes.finance.periods.close(february.id)).send({})

      expect(response.status).toBe(OK)
      const second = await owner.fiscalPeriod.findUniqueOrThrow({ where: { id: february.id } })
      expect(second.closingHash).not.toBe(first.closingHash)
      // The api offers the new head, never the old one that the reopened row kept, in the answer of the close and in the read of the period
      expect((response.body as PeriodBody).closingHash).toBe(second.closingHash)
      expect((response.body as PeriodBody).closingHash).not.toBe(first.closingHash)
      const read = await asAdminA().get(ApiRoutes.finance.periods.byId(february.id))
      expect((read.body as PeriodBody).closingHash).toBe(second.closingHash)
      expect(second.reopenReason).toBe('The bank corrected a payment')
    })

    it('refuses a month when an earlier month has no period at all (a hole in the calendar)', async () => {
      const opened = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: 2026, month: 5 })

      const response = await asAdminA()
        .post(ApiRoutes.finance.periods.close((opened.body as PeriodBody).id))
        .send({})

      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_CLOSE_PREVIOUS_OPEN)
    })

    it('refuses a month that has not ended', async () => {
      const now = new Date()
      const opened = await asAdminA()
        .post(ApiRoutes.finance.periods.open)
        .send({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 })
      expect(opened.status).toBeLessThan(BAD_REQUEST)
      const current = opened.body as PeriodBody

      const response = await asAdminA().post(ApiRoutes.finance.periods.close(current.id)).send({})

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.FINANCE_CLOSE_NOT_ENDED)
    })
  })

  describe('the reports', () => {
    it('adds the trial balance up and shows the same figures as the balances', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.trialBalance)
        .query({ periodId: january.id })

      const report = response.body as TrialBody
      expect(response.status).toBe(OK)
      expect(report.totals).toEqual({ debitCents: '1325', creditCents: '1325', balanced: true })
      expect(report.rows.map(row => row.code).sort()).toEqual([CASH, RENT].sort())
    })

    it('gives the ledger of an account with a running balance that ends at its balance', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: accountsA[CASH], from: '2026-01-01', to: '2026-01-31' })

      const ledger = response.body as LedgerBody
      expect(response.status).toBe(OK)
      expect(ledger.openingCents).toBe('0')
      // Cash is an asset and every line credits it: the balance goes down by each one
      expect(ledger.lines.map(line => line.runningCents)).toEqual(['-1000', '-1250', '-1325'])
    })

    it('pages the ledger and carries the balance across the pages', async () => {
      const first = await asAdminA()
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: accountsA[RENT], limit: 2 })
      const next = await asAdminA()
        .get(ApiRoutes.finance.reports.ledger)
        .query({
          accountId: accountsA[RENT],
          limit: 2,
          cursor: (first.body as LedgerBody).nextCursor ?? ''
        })

      const one = first.body as LedgerBody
      const two = next.body as LedgerBody
      expect(one.hasMore).toBe(true)
      expect(two.openingCents).toBe(one.lines.at(-1)?.runningCents)
    })

    it('gives the balance of each account at a date, carried since the start and not cut by period', async () => {
      const at = (asOf: string) =>
        asAdminA().get(ApiRoutes.finance.reports.accountBalances).query({ asOf })

      const january31 = await at('2026-01-31')
      const before = await at('2026-01-14')

      const report = january31.body as AccountBalancesBody
      const cash = report.rows.find(row => row.accountId === accountsA[CASH])
      const rent = report.rows.find(row => row.accountId === accountsA[RENT])
      expect(january31.status).toBe(OK)
      // Cash is an asset every line credits; rent is an expense every line debits
      expect(cash?.balanceCents).toBe('-1325')
      expect(rent?.balanceCents).toBe('1325')
      expect(report.totals).toEqual({ debitCents: '1325', creditCents: '1325', balanced: true })
      // Before the first entry no account has a line: only the accounts of money stay, at zero
      expect((before.body as AccountBalancesBody).rows.every(row => row.cashKind !== null)).toBe(
        true
      )
      expect((before.body as AccountBalancesBody).rows.every(row => row.balanceCents === '0')).toBe(
        true
      )
    })

    it('narrows the balances to one store, and says it cannot add them up then', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.accountBalances)
        .query({ asOf: '2026-01-31', storeId: ctx.storeA.id })

      expect(response.status).toBe(OK)
      expect((response.body as AccountBalancesBody).totals.balanced).toBeNull()
    })

    it('answers 404 to the store of another organization, and 400 to a date that does not exist', async () => {
      const other = await asAdminA()
        .get(ApiRoutes.finance.reports.accountBalances)
        .query({ asOf: '2026-01-31', storeId: ctx.storeB.id })
      const bad = await asAdminA()
        .get(ApiRoutes.finance.reports.accountBalances)
        .query({ asOf: '2026-02-31' })

      expect([other.status, bad.status]).toEqual([NOT_FOUND, BAD_REQUEST])
    })

    it('filters the ledger by party, and takes a party id only with its type', async () => {
      const query = { accountId: accountsA[CASH], from: '2026-01-01', to: '2026-01-31' }
      const unknown = await asAdminA()
        .get(ApiRoutes.finance.reports.ledger)
        .query({ ...query, partyType: PartyType.SUPPLIER, partyId: randomUUID() })
      const ofType = await asAdminA()
        .get(ApiRoutes.finance.reports.ledger)
        .query({ ...query, partyType: PartyType.CUSTOMER })
      const idOnly = await asAdminA()
        .get(ApiRoutes.finance.reports.ledger)
        .query({ ...query, partyId: randomUUID() })

      // The lines of the suite name no party: a filter by one leaves none, and the opening is the one of that party
      expect((unknown.body as LedgerBody).lines).toEqual([])
      expect((ofType.body as LedgerBody).lines).toEqual([])
      expect(idOnly.status).toBe(BAD_REQUEST)
    })

    it('gives the journal of a range with the lines of every entry, in number order and by pages of whole entries', async () => {
      const first = await asAdminA()
        .get(ApiRoutes.finance.reports.journal)
        .query({ from: '2026-01-01', to: '2026-01-31', limit: 2 })
      const next = await asAdminA()
        .get(ApiRoutes.finance.reports.journal)
        .query({
          from: '2026-01-01',
          to: '2026-01-31',
          limit: 2,
          cursor: (first.body as JournalBody).nextCursor ?? ''
        })

      const one = first.body as JournalBody
      const two = next.body as JournalBody
      expect(first.status).toBe(OK)
      expect(one.hasMore).toBe(true)
      expect(two.hasMore).toBe(false)
      const all = [...one.data, ...two.data]
      expect(all.map(entry => entry.hash)).toEqual(janHashes)
      expect(all.every(entry => entry.lines.length === 2)).toBe(true)
      expect(all.map(entry => entry.lines.reduce((sum, line) => sum + line.debitCents, 0))).toEqual(
        all.map(entry => entry.lines.reduce((sum, line) => sum + line.creditCents, 0))
      )
    })

    it('reads the journal only with finance:view_journal and never shows the entries of another organization', async () => {
      const viewer = await asRole('viewer-only-journal', [Permissions.FINANCE_VIEW])
      const journal = await asRole('journal-reader', [Permissions.FINANCE_VIEW_JOURNAL])

      const refused = await viewer
        .get(ApiRoutes.finance.reports.journal)
        .query({ from: '2026-01-01', to: '2026-01-31' })
      const allowed = await journal
        .get(ApiRoutes.finance.reports.journal)
        .query({ from: '2026-01-01', to: '2026-12-31', limit: 100 })

      expect(refused.status).toBe(FORBIDDEN)
      expect(allowed.status).toBe(OK)
      expect(JSON.stringify(allowed.body)).not.toContain('Only of B')
    })

    it('reads the ledger only with finance:view_journal, and the trial balance with finance:view', async () => {
      const viewer = await asRole('viewer-only', [Permissions.FINANCE_VIEW])
      const journal = await asRole('journal-only', [Permissions.FINANCE_VIEW_JOURNAL])

      const read = await viewer
        .get(ApiRoutes.finance.reports.trialBalance)
        .query({ periodId: january.id })
      const ledger = await viewer
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: accountsA[CASH] })
      const trialOfJournal = await journal
        .get(ApiRoutes.finance.reports.trialBalance)
        .query({ periodId: january.id })
      const ledgerOfJournal = await journal
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: accountsA[CASH] })

      expect([read.status, ledger.status, trialOfJournal.status, ledgerOfJournal.status]).toEqual([
        OK,
        FORBIDDEN,
        FORBIDDEN,
        OK
      ])
    })

    it('does not give another organization the period or the account of this one', async () => {
      const period = await asAdminB()
        .get(ApiRoutes.finance.reports.trialBalance)
        .query({ periodId: january.id })
      const account = await asAdminB()
        .get(ApiRoutes.finance.reports.ledger)
        .query({ accountId: accountsA[CASH] })

      expect([period.status, account.status]).toEqual([NOT_FOUND, NOT_FOUND])
    })
  })

  describe('the files of the auditor', () => {
    const csvOf = (text: string): string[][] => {
      const rows: string[][] = []
      let row: string[] = []
      let cell = ''
      let quoted = false
      for (let index = 0; index < text.length; index += 1) {
        const character = text.charAt(index)
        if (quoted) {
          if (character === '"' && text.charAt(index + 1) === '"') {
            cell += '"'
            index += 1
          } else if (character === '"') quoted = false
          else cell += character
        } else if (character === '"') quoted = true
        else if (character === ',') {
          row.push(cell)
          cell = ''
        } else if (character === '\r') continue
        else if (character === '\n') {
          row.push(cell)
          rows.push(row)
          row = []
          cell = ''
        } else cell += character
      }
      return rows
    }

    it('writes the journal with a row per line and no cache, and leaves an audit row', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: '2026-01-01', to: '2026-01-31' })
        .buffer(true)
        .parse((res, done) => {
          let data = ''
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')))
          res.on('end', () => done(null, data))
        })

      expect(response.status).toBe(OK)
      expect(response.headers['content-type']).toContain('text/csv')
      expect(response.headers['cache-control']).toBe('no-store')
      const rows = csvOf((response.body as string).replace(/^\uFEFF/, ''))
      // The header and two lines for each of the three entries
      expect(rows).toHaveLength(7)
      await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_EXPORTED
      })
    })

    it('writes the same rows when it reads the journal in several pages, and the audit row counts them', async () => {
      // Two lines per page: the three entries of the case take three pages, each read in a unit of its own
      const limits: { CSV_PAGE_SIZE: number } = FinanceReportLimits // the same object, typed to take another number
      const pageSize = jest.replaceProperty(limits, 'CSV_PAGE_SIZE', 2)
      const exported = { organizationId: ctx.orgA.id, action: AuditAction.FINANCE_EXPORTED }
      const before = await owner.auditLog.count({ where: exported })
      try {
        const response = await asAdminA()
          .get(ApiRoutes.finance.reports.journalCsv)
          .query({ from: '2026-01-01', to: '2026-01-31' })
          .buffer(true)
          .parse((res, done) => {
            let data = ''
            res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')))
            res.on('end', () => done(null, data))
          })
        expect(response.status).toBe(OK)
        const rows = csvOf((response.body as string).replace(/^\uFEFF/, ''))
        expect(rows).toHaveLength(7)
        // Only the row of THIS request counts: wait for one more than before, and read the newest
        const audited = await waitForAuditEntries(owner, exported, before + 1)
        expect(audited).toHaveLength(before + 1)
        expect(audited.at(-1)?.metadata).toMatchObject({ report: 'journal', rows: rows.length - 1 })
      } finally {
        pageSize.restore()
      }
    })

    it('carries what the chain hashes, so the file alone verifies against it', async () => {
      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: '2026-01-01', to: '2026-01-31' })
        .buffer(true)
        .parse((res, done) => {
          let data = ''
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')))
          res.on('end', () => done(null, data))
        })
      const [header, ...rows] = csvOf((response.body as string).replace(/^\uFEFF/, ''))
      const col = (name: string): number => (header ?? []).indexOf(name)
      const nullable = (value: string | undefined): string | null =>
        value === undefined || value === '' ? null : value
      const entries = new Map<string, ChainEntry>()
      for (const row of rows) {
        const id = row[col('entry_id')] ?? ''
        const entry: ChainEntry = entries.get(id) ?? {
          id,
          number: BigInt(row[col('number')] ?? '0'),
          entryDate: row[col('entry_date')] ?? '',
          periodId: row[col('period_id')] ?? '',
          totalCents: Number(row[col('total_cents')]),
          currency: row[col('currency')] ?? '',
          type: row[col('type')] ?? '',
          sourceType: nullable(row[col('source_type')]),
          sourceId: nullable(row[col('source_id')]),
          sourceDate: nullable(row[col('source_date')]),
          reversesEntryId: nullable(row[col('reverses_entry_id')]),
          idempotencyKey: row[col('idempotency_key')] ?? '',
          memo: nullable(row[col('entry_memo')]),
          origin: row[col('origin')] ?? '',
          createdBy: nullable(row[col('created_by')]),
          prevHash: nullable(row[col('prev_hash')]),
          hash: row[col('hash')] ?? '',
          lines: []
        }
        entry.lines = [
          ...entry.lines,
          {
            lineNo: Number(row[col('line_no')]),
            accountId: row[col('account_id')] ?? '',
            debitCents: Number(row[col('debit_cents')]),
            creditCents: Number(row[col('credit_cents')]),
            storeId: nullable(row[col('store_id')]),
            partyType: nullable(row[col('party_type')]),
            partyId: nullable(row[col('party_id')]),
            taxRateId: nullable(row[col('tax_rate_id')]),
            memo: nullable(row[col('line_memo')])
          }
        ]
        entries.set(id, entry)
      }

      const list = [...entries.values()].sort((x, y) => (x.number < y.number ? -1 : 1))

      expect(list.map(entry => entry.hash)).toEqual(janHashes)
      expect(verifyChain(list)).toBeNull()
    })

    it('writes a text that starts like a formula as text', async () => {
      await post(asAdminA, accountsA, '2026-03-05', 7, '=HYPERLINK("http://example.test")')

      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: '2026-03-01', to: '2026-03-31' })
        .buffer(true)
        .parse((res, done) => {
          let data = ''
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')))
          res.on('end', () => done(null, data))
        })

      const text = response.body as string
      expect(text).toContain(`"'=HYPERLINK(""http://example.test"")"`)
      expect(text).not.toMatch(/(^|,)=HYPERLINK/m)
    })

    it('writes the ledger and the trial balance as numbers, negative ones included', async () => {
      const ledger = await asAdminA()
        .get(ApiRoutes.finance.reports.ledgerCsv)
        .query({ accountId: accountsA[CASH], from: '2026-01-01', to: '2026-01-31' })
      const trial = await asAdminA()
        .get(ApiRoutes.finance.reports.trialBalanceCsv)
        .query({ periodId: january.id })

      expect(ledger.status).toBe(OK)
      expect(ledger.text).toContain(',-1000\r\n')
      expect(trial.status).toBe(OK)
      expect(trial.text).not.toContain("'-")
    })

    it('needs finance:export besides what the file shows', async () => {
      const noExport = await asRole('journal-no-export', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL
      ])
      const noJournal = await asRole('export-no-journal', [
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_EXPORT
      ])
      const range = { from: '2026-01-01', to: '2026-01-31' }

      const statuses = [
        (await noExport.get(ApiRoutes.finance.reports.journalCsv).query(range)).status,
        (await noJournal.get(ApiRoutes.finance.reports.journalCsv).query(range)).status,
        (await noExport.post(ApiRoutes.finance.reports.verifyChain).send({})).status,
        (
          await noExport
            .get(ApiRoutes.finance.reports.trialBalanceCsv)
            .query({ periodId: january.id })
        ).status
      ]

      expect(statuses).toEqual([FORBIDDEN, FORBIDDEN, FORBIDDEN, FORBIDDEN])
    })

    it('refuses a range longer than a year, and a range that goes backwards', async () => {
      const long = await asAdminA()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: '2024-01-01', to: '2026-01-31' })
      const backwards = await asAdminA()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: '2026-02-01', to: '2026-01-31' })

      expect([long.status, backwards.status]).toEqual([BAD_REQUEST, BAD_REQUEST])
    })

    it('does not carry the entries of another organization', async () => {
      await post(asAdminB, accountsB, '2026-01-15', 33, 'Only of B')

      const response = await asAdminA()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: '2026-01-01', to: '2026-12-31' })

      expect(response.text).not.toContain('Only of B')
    })
  })

  describe('the check of the chain', () => {
    it('says the chain is sound, with its head, and writes an audit row', async () => {
      const response = await asAdminA().post(ApiRoutes.finance.reports.verifyChain).send({})

      const result = response.body as ChainBody
      expect(response.status).toBe(OK)
      expect(result.ok).toBe(true)
      expect(result.break).toBeNull()
      expect(result.entriesChecked).toBeGreaterThanOrEqual(janHashes.length)
      expect(result.frozenHeads.every(frozen => frozen.present)).toBe(true)
      await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_CHAIN_VERIFIED
      })
    })

    it('finds a head that does not follow the last entry (a tail cut off behind the application)', async () => {
      await tamperWithLedger(owner, [
        `UPDATE finance_settings SET last_entry_hash = 'cut' WHERE organization_id = '${ctx.orgB.id}'`
      ])

      const response = await asAdminB().post(ApiRoutes.finance.reports.verifyChain).send({})

      expect((response.body as ChainBody).break?.reason).toBe('head_mismatch')
      await tamperWithLedger(owner, [
        `UPDATE finance_settings SET last_entry_hash = (SELECT hash FROM journal_entries WHERE organization_id = '${ctx.orgB.id}' ORDER BY number DESC LIMIT 1) WHERE organization_id = '${ctx.orgB.id}'`
      ])
    })

    it('refuses a second check while one runs for the organization', async () => {
      const [first, second] = await Promise.all([
        asAdminB().post(ApiRoutes.finance.reports.verifyChain).send({}),
        asAdminB().post(ApiRoutes.finance.reports.verifyChain).send({})
      ])

      expect([first.status, second.status].sort()).toEqual([OK, CONFLICT].sort())
    })

    it('finds a figure changed in place', async () => {
      await asAdminB().post(ApiRoutes.finance.reports.verifyChain).send({})
      await tamperWithLedger(owner, [
        `UPDATE journal_lines SET debit_cents = debit_cents + 1 WHERE organization_id = '${ctx.orgB.id}' AND debit_cents > 0`
      ])

      const response = await asAdminB().post(ApiRoutes.finance.reports.verifyChain).send({})

      const result = response.body as ChainBody
      expect(result.ok).toBe(false)
      expect(result.break?.reason).toBe('hash_mismatch')
    })

    it('finds a memo changed in place', async () => {
      await tamperWithLedger(owner, [
        `UPDATE journal_entries SET memo = 'Rewritten' WHERE organization_id = '${ctx.orgA.id}' AND number = 2`
      ])

      const response = await asAdminA().post(ApiRoutes.finance.reports.verifyChain).send({})

      expect((response.body as ChainBody).break?.reason).toBe('hash_mismatch')
    })

    it('says how many entries it checked before the break, also when the break is in the first page of the walk', async () => {
      // The memo of the second entry is changed (here, not relied on from another case): the first one is the only one checked and sound
      await tamperWithLedger(owner, [
        `UPDATE journal_entries SET memo = 'Rewritten for the count' WHERE organization_id = '${ctx.orgA.id}' AND number = 2`
      ])
      const response = await asAdminA().post(ApiRoutes.finance.reports.verifyChain).send({})
      const result = response.body as ChainBody
      expect(result.break).toMatchObject({ reason: 'hash_mismatch', number: '2' })
      expect(result.entriesChecked).toBe(1)

      const status = await asAdminA().get(ApiRoutes.finance.reports.chainStatus)
      expect(
        (status.body as { open: { entriesChecked: number } | null }).open?.entriesChecked
      ).toBe(1)
    })
  })
})
