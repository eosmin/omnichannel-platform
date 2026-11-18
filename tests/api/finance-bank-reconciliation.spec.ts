import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type supertest from 'supertest'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  BankStatementLimits,
  FinanceConflicts,
  FinanceCountryCodes,
  FinanceResourceTypes,
  FinanceTransactionKind
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface ProfileBody {
  id: string
  accountId: string
  encoding: string
}
interface ImportBody {
  id: string
  lineCount: number
  newLineCount: number
  mediaId: string
}
interface SuggestionBody {
  bookLineId: string
  exact: boolean
  dayDifference: number
}
interface LineBody {
  id: string
  lineNo: number
  amountCents: number
  match: { id: string; journalLineId: string } | null
  group: {
    id: string
    pieces: { matchId: string; journalLineId: string; signedCents: number }[]
  } | null
  suggestions: SuggestionBody[]
}
interface PageBody {
  items: LineBody[]
  next: number | null
  counts: { total: number; matched: number; unmatched: number; suggested: number }
}

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const BANK = '111001'
const CASH = '1101'
const SERVICES = '6106'
const TODAY = new Date().toISOString().slice(0, 10)
const day = (offset: number): string =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

const HEADER = 'Date,Description,Ref,Amount'

// The bank reconciliation by CSV (TDD_18 §4.4; Step 4B.4b-2). A person imports the CSV a bank gives, the lines are SUGGESTED against the
// journal lines of the bank account and a person decides; nothing posts or edits the journal. The books belong to the organization:
// nothing crosses organizations.
describe('The bank reconciliation by CSV (Step 4B.4b-2)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let accountsB: Record<string, string> = {}
  let reconciler: Actor
  let journalReader: Actor
  let profile: ProfileBody

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const [actor, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, actor, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    const byCode = async (organizationId: string) =>
      Object.fromEntries(
        (
          await owner.ledgerAccount.findMany({
            where: { organizationId },
            select: { id: true, code: true }
          })
        ).map(row => [row.code, row.id])
      )
    accounts = await byCode(ctx.orgA.id)
    accountsB = await byCode(ctx.orgB.id)
    const base = { prefix, organizationId: ctx.orgA.id, storeId: ctx.storeA.id }
    reconciler = await actorWithPermissions(owner, app, {
      ...base,
      name: 'reconcilerA',
      permissions: [Permissions.FINANCE_RECONCILE]
    })
    journalReader = await actorWithPermissions(owner, app, {
      ...base,
      name: 'journalReaderBankA',
      permissions: [Permissions.FINANCE_VIEW_JOURNAL, Permissions.FINANCE_MANAGE_TRANSACTIONS]
    })
    profile = await makeProfile(accounts[BANK] ?? '', 'main')
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const conflictOf = (body: unknown) =>
    (body as ErrorBody).error.metadata?.['conflict'] as string | undefined
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asReconciler = () => api(app, reconciler, ctx.storeA)

  async function makeProfile(
    accountId: string,
    name: string,
    overrides: Record<string, unknown> = {}
  ): Promise<ProfileBody> {
    const response = await asAdmin()
      .post(ApiRoutes.finance.bank.profiles)
      .send({
        accountId,
        name: `${name}-${randomUUID().slice(0, 8)}`,
        columns: { date: 'Date', description: 'Description', reference: 'Ref', amount: 'Amount' },
        ...overrides
      })
    expect(response.status).toBe(CREATED)
    return response.body as ProfileBody
  }

  // A line of the books on the bank account: an expense from it (money out) or an income into it (money in)
  async function bookLine(
    kind: 'out' | 'in',
    amountCents: number,
    occurredOn = TODAY,
    extra: Record<string, unknown> = {}
  ): Promise<string> {
    const incomeAccount = await owner.ledgerAccount.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id, type: 'income', isPostable: true }
    })
    const response = await asAdmin()
      .post(ApiRoutes.finance.transactions.record)
      .send(
        kind === 'out'
          ? {
              idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
              kind: FinanceTransactionKind.EXPENSE,
              occurredOn,
              amountCents,
              fromAccountId: accounts[BANK],
              categoryAccountId: accounts[SERVICES],
              ...extra
            }
          : {
              idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
              kind: FinanceTransactionKind.INCOME,
              occurredOn,
              amountCents,
              toAccountId: accounts[BANK],
              categoryAccountId: incomeAccount.id,
              ...extra
            }
      )
    expect(response.status).toBe(CREATED)
    const transaction = await owner.financeTransaction.findFirstOrThrow({
      where: { id: (response.body as { id: string }).id }
    })
    const line = await owner.journalLine.findFirstOrThrow({
      where: { entryId: transaction.entryId, accountId: accounts[BANK] }
    })
    return line.id
  }

  const send = (
    text: string | Buffer,
    profileId = profile.id,
    query = '',
    type = 'text/csv',
    who = asAdmin
  ) =>
    who()
      .post(`${ApiRoutes.finance.bank.imports}?profileId=${profileId}${query}`)
      .set('Content-Type', type)
      .send(text)
  async function imported(rows: string[], profileId = profile.id, query = ''): Promise<ImportBody> {
    const response = await send(`${HEADER}\n${rows.join('\n')}\n`, profileId, query)
    expect(response.status).toBe(CREATED)
    return response.body as ImportBody
  }
  async function linesOf(importId: string, query = ''): Promise<PageBody> {
    const response = await asAdmin().get(`${ApiRoutes.finance.bank.importLines(importId)}${query}`)
    expect(response.status).toBe(OK)
    return response.body as PageBody
  }
  const confirm = (lineId: string, journalLineId: string, who = asAdmin) =>
    who().post(ApiRoutes.finance.bank.lineMatches(lineId)).send({ journalLineId })

  describe('the profiles', () => {
    it('are made for a cash, bank or wallet account, and are read back with the same shape', async () => {
      const list = await asAdmin().get(
        `${ApiRoutes.finance.bank.profiles}?accountId=${accounts[BANK]}`
      )
      expect(list.status).toBe(OK)
      expect((list.body as ProfileBody[]).map(item => item.id)).toContain(profile.id)
      const refused = await asAdmin()
        .post(ApiRoutes.finance.bank.profiles)
        .send({
          accountId: accounts[SERVICES],
          name: 'expense account',
          columns: { date: 'Date', amount: 'Amount' }
        })
      expect(refused.status).toBe(CONFLICT)
      expect(conflictOf(refused.body)).toBe(FinanceConflicts.BANK_ACCOUNT_NOT_CASH)
    })

    it('refuse a mapping that breaks a rule, a name taken and an account of another organization', async () => {
      const both = await asAdmin()
        .post(ApiRoutes.finance.bank.profiles)
        .send({
          accountId: accounts[BANK],
          name: 'both',
          columns: { date: 'Date', amount: 'Amount', debit: 'D', credit: 'C' }
        })
      expect(both.status).toBe(BAD_REQUEST)
      const duplicate = {
        accountId: accounts[BANK],
        name: `dup-${randomUUID().slice(0, 6)}`,
        columns: { date: 'Date', amount: 'Amount' }
      }
      expect((await asAdmin().post(ApiRoutes.finance.bank.profiles).send(duplicate)).status).toBe(
        CREATED
      )
      const taken = await asAdmin().post(ApiRoutes.finance.bank.profiles).send(duplicate)
      expect(taken.status).toBe(CONFLICT)
      expect(conflictOf(taken.body)).toBe(FinanceConflicts.BANK_PROFILE_NAME_IN_USE)
      const other = await asAdmin()
        .post(ApiRoutes.finance.bank.profiles)
        .send({
          accountId: accountsB[BANK],
          name: 'cross',
          columns: { date: 'Date', amount: 'Amount' }
        })
      expect(other.status).toBe(NOT_FOUND)
    })

    it('are changed and removed, and an update that leaves a broken profile is refused', async () => {
      const made = await makeProfile(accounts[BANK] ?? '', 'edit')
      const changed = await asAdmin()
        .patch(ApiRoutes.finance.bank.profileById(made.id))
        .send({ dateWindowDays: 5 })
      expect(changed.status).toBe(OK)
      const broken = await asAdmin()
        .patch(ApiRoutes.finance.bank.profileById(made.id))
        .send({ decimalSeparator: ',', delimiter: ',' })
      expect(broken.status).toBe(BAD_REQUEST)
      const gone = await asAdmin().delete(ApiRoutes.finance.bank.profileById(made.id))
      expect(gone.status).toBe(NO_CONTENT)
      const again = await asAdmin().delete(ApiRoutes.finance.bank.profileById(made.id))
      expect(again.status).toBe(NOT_FOUND)
    })

    it('are the organization own: another organization reads, changes and removes none', async () => {
      const list = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.finance.bank.profiles)
      expect((list.body as ProfileBody[]).map(item => item.id)).not.toContain(profile.id)
      const patched = await api(app, ctx.adminB, ctx.storeB)
        .patch(ApiRoutes.finance.bank.profileById(profile.id))
        .send({ name: 'taken over' })
      expect(patched.status).toBe(NOT_FOUND)
      const removed = await api(app, ctx.adminB, ctx.storeB).delete(
        ApiRoutes.finance.bank.profileById(profile.id)
      )
      expect(removed.status).toBe(NOT_FOUND)
    })

    it('read a sample in the mapper and write nothing', async () => {
      const before = await owner.bankStatementImport.count({
        where: { organizationId: ctx.orgA.id }
      })
      const response = await asAdmin()
        .post(ApiRoutes.finance.bank.profilePreview)
        .send({
          text: `${HEADER}\n${TODAY},A,R1,10.00\n${TODAY},B,,abc\n`,
          profile: {
            columns: {
              date: 'Date',
              description: 'Description',
              reference: 'Ref',
              amount: 'Amount'
            }
          }
        })
      expect(response.status).toBe(OK)
      const body = response.body as { lines: unknown[]; errorCount: number }
      expect(body.lines).toHaveLength(1)
      expect(body.errorCount).toBe(1)
      expect(
        await owner.bankStatementImport.count({ where: { organizationId: ctx.orgA.id } })
      ).toBe(before)
    })
  })

  describe('the import', () => {
    it('reads the file, keeps it as a finance file with no parent and makes lines that no match touches', async () => {
      const first = await imported([`${day(-20)},Deposit,R-1,100.00`, `${day(-19)},Fee,,-1.50`])
      expect(first).toMatchObject({ lineCount: 2, newLineCount: 2 })
      const media = await owner.media.findFirstOrThrow({ where: { id: first.mediaId } })
      expect(media).toMatchObject({
        purpose: 'finance_document',
        financeTransactionId: null,
        storeId: ctx.storeA.id
      })
      const page = await linesOf(first.id)
      expect(page.counts).toEqual({ total: 2, matched: 0, unmatched: 2, suggested: 0 })
      expect(page.items.map(item => item.amountCents)).toEqual([10000, -150])
      expect(
        await owner.reconciliationMatch.count({ where: { organizationId: ctx.orgA.id } })
      ).toBe(0)
    })

    it('answers 409 for a file whose lines were all imported, and brings only the new ones of an overlap', async () => {
      const rows = [`${day(-40)},Old one,O-1,20.00`, `${day(-39)},Old two,O-2,30.00`]
      const first = await imported(rows)
      expect(first.newLineCount).toBe(2)
      const again = await send(`${HEADER}\n${rows.join('\n')}\n`)
      expect(again.status).toBe(CONFLICT)
      expect(conflictOf(again.body)).toBe(FinanceConflicts.BANK_IMPORT_NOTHING_NEW)
      const overlap = await imported([...rows, `${day(-38)},Old three,O-3,40.00`])
      expect(overlap).toMatchObject({ lineCount: 3, newLineCount: 1 })
      expect((await linesOf(overlap.id)).items.map(item => item.amountCents)).toEqual([4000])
      // nothing of the refused file was kept: no media row without its import
      expect(
        await owner.media.count({
          where: {
            purpose: 'finance_document',
            store: { organizationId: ctx.orgA.id },
            bankImport: null,
            financeTransactionId: null
          }
        })
      ).toBe(0)
    })

    it('keeps two identical lines of a statement as two, and reads them the same when the file comes again', async () => {
      const row = `${day(-60)},Same,S-1,7.00`
      const first = await imported([row, row])
      expect(first.newLineCount).toBe(2)
      const again = await send(`${HEADER}\n${row}\n${row}\n`)
      expect(again.status).toBe(CONFLICT)
    })

    it('refuses the whole file with the rows that failed, and writes nothing', async () => {
      const before = await owner.bankStatementLine.count({ where: { organizationId: ctx.orgA.id } })
      const response = await send(
        `${HEADER}\n${day(-3)},Good,,1.00\nnot-a-date,Bad,,2.00\n${day(-3)},Worse,,abc\n`
      )
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.BANK_STATEMENT_INVALID)
      const metadata = (response.body as ErrorBody).error.metadata as {
        errorCount: number
        errors: { row: number; code: string }[]
      }
      expect(metadata.errorCount).toBe(2)
      expect(metadata.errors.map(error => error.row)).toEqual([3, 4])
      expect(await owner.bankStatementLine.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before
      )
    })

    it('refuses a type that is not text, a body past the limit and a profile of another organization', async () => {
      const wrongType = await send('x', profile.id, '', 'application/json')
      expect(wrongType.status).toBe(BAD_REQUEST)
      const huge = await send(Buffer.alloc(5 * 1024 * 1024 + 10, 'a'))
      expect(huge.status).toBe(413)
      const crossed = await api(app, ctx.adminB, ctx.storeB)
        .post(`${ApiRoutes.finance.bank.imports}?profileId=${profile.id}`)
        .set('Content-Type', 'text/csv')
        .send(`${HEADER}\n${TODAY},A,,1.00\n`)
      expect(crossed.status).toBe(NOT_FOUND)
    })

    it('reads the encoding the profile names and refuses bytes that are not that encoding', async () => {
      const latin = await makeProfile(accounts[BANK] ?? '', 'latin1', { encoding: 'windows-1252' })
      const ok = await send(
        Buffer.from(`${HEADER}\n${day(-70)},Depósito niño,L-1,12.00\n`, 'latin1'),
        latin.id
      )
      expect(ok.status).toBe(CREATED)
      const page = await asAdmin().get(
        `${ApiRoutes.finance.bank.importLines((ok.body as ImportBody).id)}`
      )
      expect(
        ((page.body as PageBody).items[0] as unknown as { description: string }).description
      ).toBe('Depósito niño')
      // The same bytes read as UTF-8 are not text
      const strict = await send(Buffer.from(`${HEADER}\n${day(-71)},Depósito,L-2,1.00\n`, 'latin1'))
      expect(strict.status).toBe(BAD_REQUEST)
      expect(codeOf(strict.body)).toBe(ErrorCodes.BANK_STATEMENT_INVALID)
    })

    it('reads a statement with a column of debits and one of credits, zeros included', async () => {
      const split = await makeProfile(accounts[BANK] ?? '', 'split', {
        columns: {
          date: 'Date',
          description: 'Description',
          reference: 'Ref',
          debit: 'Debit',
          credit: 'Credit'
        }
      })
      const response = await send(
        `Date,Description,Ref,Debit,Credit\n${day(-95)},Out,,5.00,0.00\n${day(-95)},In,,0.00,7.00\n`,
        split.id
      )
      expect(response.status).toBe(CREATED)
      const lines = await owner.bankStatementLine.findMany({
        where: { importId: (response.body as ImportBody).id },
        orderBy: { lineNo: 'asc' }
      })
      expect(lines.map(line => line.amountCents)).toEqual([-500, 700])
    })

    it('takes an empty closing balance for none, and refuses a day without one', async () => {
      const response = await send(
        `${HEADER}\n${day(-96)},Empty,,1.00\n`,
        profile.id,
        '&closingBalanceCents=&closingOn=2022-05-11'
      )
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('takes an empty closing day like an empty balance: both empty is a statement with no balance', async () => {
      const both = await send(
        `${HEADER}\n${day(-97)},Both empty ${randomUUID()},,1.00\n`,
        profile.id,
        '&closingBalanceCents=&closingOn='
      )
      expect(both.status).toBe(CREATED)
      expect(both.body).toMatchObject({ closingBalanceCents: null, closingOn: null })
      // A balance with an empty day is still a balance without its day
      const noDay = await send(
        `${HEADER}\n${day(-98)},No day ${randomUUID()},,1.00\n`,
        profile.id,
        '&closingBalanceCents=100&closingOn='
      )
      expect(noDay.status).toBe(BAD_REQUEST)
    })

    it('reads a closing balance that is a whole number of cents and nothing else', async () => {
      const before = await owner.bankStatementImport.count({
        where: { organizationId: ctx.orgA.id }
      })
      for (const bad of ['%20', '%20%20', '1e3', '0x10', '12.5', '%2B5', '1%2C000', 'abc']) {
        const response = await send(
          `${HEADER}\n${day(-71)},Strict ${randomUUID()},,1.00\n`,
          profile.id,
          `&closingBalanceCents=${bad}&closingOn=2022-05-11`
        )
        expect([bad, response.status]).toEqual([bad, BAD_REQUEST])
      }
      expect(
        await owner.bankStatementImport.count({ where: { organizationId: ctx.orgA.id } })
      ).toBe(before)
      const ok = await send(
        `${HEADER}\n${day(-71)},Strict ${randomUUID()},,1.00\n`,
        profile.id,
        '&closingBalanceCents=-5000&closingOn=2022-05-11'
      )
      expect(ok.status).toBe(CREATED)
      expect(ok.body).toMatchObject({ closingBalanceCents: -5000, closingOn: '2022-05-11' })
    })

    it('reads a description that spans lines as one line and keeps the reference strict', async () => {
      const text = `Line one\nLine two ${randomUUID().slice(0, 8)}`
      const made = await imported([`${day(-72)},"${text}",,3.00`])
      const stored = await owner.bankStatementLine.findFirstOrThrow({
        where: { importId: made.id }
      })
      expect(stored.description).toBe(text.replace('\n', ' '))
      const refused = await send(`${HEADER}\n${day(-72)},A,"R\n1",3.00\n`)
      expect(refused.status).toBe(BAD_REQUEST)
      expect(codeOf(refused.body)).toBe(ErrorCodes.BANK_STATEMENT_INVALID)
    })

    it('counts the length of a description in characters: an emoji is one', async () => {
      const text = `${'x'.repeat(BankStatementLimits.DESCRIPTION_MAX_LENGTH - 9)}${randomUUID().slice(0, 8)}\u{1F600}`
      const made = await imported([`${day(-73)},${text},,4.00`])
      const stored = await owner.bankStatementLine.findFirstOrThrow({
        where: { importId: made.id }
      })
      expect(stored.description).toBe(text)
    })

    it('never takes the first movement of a file with no header for the header', async () => {
      const byPosition = await makeProfile(accounts[BANK] ?? '', 'position', {
        columns: { date: 0, description: 1, reference: 2, amount: 3 }
      })
      const before = await owner.bankStatementLine.count({ where: { organizationId: ctx.orgA.id } })
      const movements = `${day(-74)},First ${randomUUID()},,6.00\n${day(-74)},Second ${randomUUID()},,7.00\n`
      const refused = await send(movements, byPosition.id)
      expect(refused.status).toBe(BAD_REQUEST)
      expect(codeOf(refused.body)).toBe(ErrorCodes.BANK_STATEMENT_INVALID)
      const metadata = (refused.body as ErrorBody).error.metadata as {
        errors: { row: number; code: string; field: string }[]
      }
      expect(metadata.errors[0]).toMatchObject({
        row: 1,
        field: 'date',
        code: 'header_looks_like_data'
      })
      expect(await owner.bankStatementLine.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before
      )
      const ok = await send(`${HEADER}\n${movements}`, byPosition.id)
      expect(ok.status).toBe(CREATED)
      expect(ok.body).toMatchObject({ lineCount: 2, newLineCount: 2 })
    })

    it('asks the person to confirm the order of the day and the month when every date reads in both', async () => {
      const dayFirst = await makeProfile(accounts[BANK] ?? '', 'dayfirst', {
        dateFormat: 'dd/MM/yyyy'
      })
      const before = await owner.bankStatementLine.count({ where: { organizationId: ctx.orgA.id } })
      const file = `${HEADER}\n03/11/2021,Ambiguous ${randomUUID()},,8.00\n05/11/2021,Ambiguous ${randomUUID()},,9.00\n`
      const asked = await send(file, dayFirst.id)
      expect(asked.status).toBe(CONFLICT)
      expect(conflictOf(asked.body)).toBe(FinanceConflicts.BANK_DATE_FORMAT_UNCONFIRMED)
      expect((asked.body as ErrorBody).error.metadata).toMatchObject({
        dateFormat: 'dd/MM/yyyy',
        firstDay: '2021-11-03',
        lastDay: '2021-11-05'
      })
      expect(await owner.bankStatementLine.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before
      )
      const confirmed = await send(file, dayFirst.id, '&dateFormatConfirmed=true')
      expect(confirmed.status).toBe(CREATED)
      expect(confirmed.body).toMatchObject({ firstDay: '2021-11-03', lastDay: '2021-11-05' })
      const decided = await send(
        `${HEADER}\n03/11/2021,Decided ${randomUUID()},,8.00\n25/11/2021,Decided ${randomUUID()},,9.00\n`,
        dayFirst.id
      )
      expect(decided.status).toBe(CREATED)
      const wrongOrder = await makeProfile(accounts[BANK] ?? '', 'monthfirst', {
        dateFormat: 'MM/dd/yyyy'
      })
      const refused = await send(
        `${HEADER}\n03/11/2021,Other ${randomUUID()},,8.00\n25/11/2021,Other ${randomUUID()},,9.00\n`,
        wrongOrder.id
      )
      expect(refused.status).toBe(BAD_REQUEST)
      expect(codeOf(refused.body)).toBe(ErrorCodes.BANK_STATEMENT_INVALID)
    })

    it('keeps a cell that starts with a formula character as text', async () => {
      const made = await imported([`${day(-80)},"=1+1",+cmd,5.00`])
      const stored = await owner.bankStatementLine.findFirstOrThrow({
        where: { importId: made.id }
      })
      expect(stored).toMatchObject({ description: '=1+1', reference: '+cmd' })
    })

    it('is audited and asks for the permission to reconcile', async () => {
      const made = await imported([`${day(-90)},Audited,A-1,9.00`])
      await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_BANK_STATEMENT_IMPORTED,
        resourceType: FinanceResourceTypes.BANK_IMPORT,
        resourceId: made.id
      })
      const denied = await send(`${HEADER}\n${TODAY},A,,1.00\n`, profile.id, '', 'text/csv', () =>
        api(app, journalReader, ctx.storeA)
      )
      expect(denied.status).toBe(FORBIDDEN)
      expect(codeOf(denied.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      const allowed = await send(
        `${HEADER}\n${day(-91)},Reconciler,,3.00\n`,
        profile.id,
        '',
        'text/csv',
        asReconciler
      )
      expect(allowed.status).toBe(CREATED)
    })
  })

  describe('the suggestions and the decisions of a person', () => {
    it('suggest the line of the books with the same amount and direction inside the window, and match nothing by themselves', async () => {
      const book = await bookLine('out', 12345, day(-10))
      await bookLine('out', 12345, day(-30))
      await bookLine('in', 12345, day(-10))
      const made = await imported([`${day(-9)},Hosting,,-123.45`])
      const page = await linesOf(made.id)
      expect(page.items[0]?.suggestions.map(item => item.bookLineId)).toEqual([book])
      expect(page.items[0]?.suggestions[0]).toMatchObject({ exact: false, dayDifference: 1 })
      expect(page.items[0]?.match).toBeNull()
      expect(
        await owner.reconciliationMatch.count({ where: { statementLineId: page.items[0]?.id } })
      ).toBe(0)
    })

    it('are decided by a person: confirm, a second confirm of either side is 409, and the books are untouched', async () => {
      const book = await bookLine('out', 22222, day(-12))
      const other = await bookLine('out', 22222, day(-12))
      const made = await imported([`${day(-12)},One,,-222.22`, `${day(-12)},Two,,-222.22`])
      const [first, second] = (await linesOf(made.id)).items
      const entriesBefore = await owner.journalEntry.count({
        where: { organizationId: ctx.orgA.id }
      })
      const hashBefore = (
        await owner.financeSettings.findFirstOrThrow({ where: { organizationId: ctx.orgA.id } })
      ).lastEntryHash
      const ok = await confirm(first?.id ?? '', book)
      expect(ok.status).toBe(CREATED)
      expect((ok.body as LineBody).match?.journalLineId).toBe(book)
      const sameLine = await confirm(first?.id ?? '', other)
      expect(sameLine.status).toBe(CONFLICT)
      expect(conflictOf(sameLine.body)).toBe(FinanceConflicts.BANK_LINE_ALREADY_MATCHED)
      const sameBook = await confirm(second?.id ?? '', book)
      expect(sameBook.status).toBe(CONFLICT)
      expect(conflictOf(sameBook.body)).toBe(FinanceConflicts.BANK_BOOK_LINE_ALREADY_MATCHED)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        entriesBefore
      )
      expect(
        (await owner.financeSettings.findFirstOrThrow({ where: { organizationId: ctx.orgA.id } }))
          .lastEntryHash
      ).toBe(hashBefore)
      await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_RECONCILIATION_CONFIRMED,
        resourceType: FinanceResourceTypes.RECONCILIATION_MATCH,
        resourceId: (ok.body as LineBody).match?.id ?? ''
      })
    })

    it('refuse a pair the rules do not allow, whatever the screen sent', async () => {
      const bookOut = await bookLine('out', 33333, day(-5))
      const wrongWay = await bookLine('in', 33333, day(-5))
      const far = await bookLine('out', 33333, day(-25))
      const made = await imported([`${day(-5)},Out,,-333.33`])
      const line = (await linesOf(made.id)).items[0]?.id ?? ''
      for (const journalLineId of [wrongWay, far]) {
        const refused = await confirm(line, journalLineId)
        expect(refused.status).toBe(CONFLICT)
        expect(conflictOf(refused.body)).toBe(FinanceConflicts.BANK_PAIR_NOT_ALLOWED)
      }
      // a line of the cash account is no candidate for a statement of the bank, and a made-up id does not exist
      expect((await confirm(line, await bookLineOnCash(33333, day(-5)))).status).toBe(NOT_FOUND)
      expect((await confirm(line, randomUUID())).status).toBe(NOT_FOUND)
      expect((await confirm(line, bookOut)).status).toBe(CREATED)
    })

    it('leave out a voided transaction and its reversal: neither reached the bank', async () => {
      const book = await bookLine('out', 44444, day(-4))
      const transaction = await owner.financeTransaction.findFirstOrThrow({
        where: { entry: { lines: { some: { id: book } } } }
      })
      const voided = await asAdmin()
        .post(ApiRoutes.finance.transactions.void(transaction.id))
        .send({ reason: 'Gone' })
      expect(voided.status).toBe(CREATED)
      const made = await imported([`${day(-4)},Voided,,-444.44`])
      const page = await linesOf(made.id)
      expect(page.items[0]?.suggestions).toEqual([])
      const refused = await confirm(page.items[0]?.id ?? '', book)
      expect(refused.status).toBe(CONFLICT)
      expect(conflictOf(refused.body)).toBe(FinanceConflicts.BANK_PAIR_NOT_ALLOWED)
    })

    it('reject a suggestion so it does not come back, and take a decision back once', async () => {
      const book = await bookLine('out', 55555, day(-6))
      const made = await imported([`${day(-6)},Rejected,,-555.55`])
      const line = (await linesOf(made.id)).items[0]?.id ?? ''
      const rejected = await asAdmin()
        .post(ApiRoutes.finance.bank.lineRejections(line))
        .send({ journalLineId: book })
      expect(rejected.status).toBe(CREATED)
      // the same rejection again writes nothing
      const again = await asAdmin()
        .post(ApiRoutes.finance.bank.lineRejections(line))
        .send({ journalLineId: book })
      expect(again.status).toBe(CREATED)
      expect(
        await owner.reconciliationMatch.count({
          where: { statementLineId: line, status: 'rejected' }
        })
      ).toBe(1)
      expect((await linesOf(made.id)).items[0]?.suggestions).toEqual([])
      const decision = await owner.reconciliationMatch.findFirstOrThrow({
        where: { statementLineId: line, status: 'rejected' }
      })
      const undone = await asAdmin().post(ApiRoutes.finance.bank.matchUndo(decision.id))
      expect(undone.status).toBe(OK)
      expect((undone.body as LineBody).suggestions.map(item => item.bookLineId)).toEqual([book])
      const twice = await asAdmin().post(ApiRoutes.finance.bank.matchUndo(decision.id))
      expect(twice.status).toBe(CONFLICT)
      expect(conflictOf(twice.body)).toBe(FinanceConflicts.BANK_DECISION_ALREADY_UNDONE)
    })

    it('take a confirmation back: the line is open again, the history stays and the pair can be confirmed again', async () => {
      const book = await bookLine('out', 66666, day(-7))
      const made = await imported([`${day(-7)},Undo,,-666.66`])
      const line = (await linesOf(made.id)).items[0]?.id ?? ''
      const ok = await confirm(line, book)
      const matchId = (ok.body as LineBody).match?.id ?? ''
      const undone = await asAdmin().post(ApiRoutes.finance.bank.matchUndo(matchId))
      expect((undone.body as LineBody).match).toBeNull()
      expect(await owner.reconciliationMatch.count({ where: { statementLineId: line } })).toBe(1)
      expect((await confirm(line, book)).status).toBe(CREATED)
      expect(await owner.reconciliationMatch.count({ where: { statementLineId: line } })).toBe(2)
    })

    it('confirm in one go the single exact ones and leave the doubtful for a person', async () => {
      const sameDay = await bookLine('out', 77001, day(-8), { documentNumber: 'DOC-77001' })
      await bookLine('out', 77002, day(-8))
      await bookLine('out', 77002, day(-8))
      const near = await bookLine('out', 77003, day(-9))
      const made = await imported([
        `${day(-8)},Exact,DOC-77001,-770.01`,
        `${day(-8)},Two options,,-770.02`,
        `${day(-8)},Days apart,,-770.03`
      ])
      const done = await asAdmin().post(ApiRoutes.finance.bank.confirmExact(made.id))
      expect(done.status).toBe(OK)
      expect(done.body).toEqual({ confirmed: 1, left: 2 })
      const page = await linesOf(made.id)
      expect(page.items.map(item => item.match?.journalLineId ?? null)).toEqual([
        sameDay,
        null,
        null
      ])
      expect(page.items[2]?.suggestions.map(item => item.bookLineId)).toEqual([near])
      expect(page.counts).toEqual({ total: 3, matched: 1, unmatched: 2, suggested: 2 })
      const filtered = await linesOf(made.id, '?filter=matched')
      expect(filtered.items).toHaveLength(1)
      const paged = await linesOf(made.id, '?limit=2')
      expect(paged.items).toHaveLength(2)
      expect(paged.next).toBe(paged.items[1]?.lineNo)
      const rest = await linesOf(made.id, `?limit=2&after=${paged.next ?? 0}`)
      expect(rest.items).toHaveLength(1)
      expect(rest.next).toBeNull()
    })

    it('block the void of a transaction whose entry is reconciled until the match is taken back', async () => {
      const book = await bookLine('out', 13131, day(-15))
      const transaction = await owner.financeTransaction.findFirstOrThrow({
        where: { entry: { lines: { some: { id: book } } } }
      })
      const made = await imported([`${day(-15)},Reconciled,,-131.31`])
      const ok = await confirm((await linesOf(made.id)).items[0]?.id ?? '', book)
      const blocked = await asAdmin()
        .post(ApiRoutes.finance.transactions.void(transaction.id))
        .send({ reason: 'Too late' })
      expect(blocked.status).toBe(CONFLICT)
      expect(codeOf(blocked.body)).toBe(ErrorCodes.FINANCE_ENTRY_RECONCILED)
      await asAdmin().post(ApiRoutes.finance.bank.matchUndo((ok.body as LineBody).match?.id ?? ''))
      const voided = await asAdmin()
        .post(ApiRoutes.finance.transactions.void(transaction.id))
        .send({ reason: 'Now it can' })
      expect(voided.status).toBe(CREATED)
    })

    it('judge the doubt of a bulk confirmation among the lines of every statement of the account, not only the one confirmed', async () => {
      const book = await bookLine('out', 88001, day(-16))
      const first = await imported([`${day(-16)},First statement,,-880.01`])
      await imported([`${day(-15)},Second statement,,-880.01`])
      const done = await asAdmin().post(ApiRoutes.finance.bank.confirmExact(first.id))
      expect(done.status).toBe(OK)
      expect(done.body).toEqual({ confirmed: 0, left: 1 })
      expect(
        await owner.reconciliationMatch.count({
          where: { journalLineId: book, status: 'confirmed' }
        })
      ).toBe(0)
    })

    it('give a matched line no rejection, and write no audit row for a rejection that changed nothing', async () => {
      const book = await bookLine('out', 14141, day(-17))
      const made = await imported([`${day(-17)},Matched,,-141.41`])
      const line = (await linesOf(made.id)).items[0]?.id ?? ''
      await confirm(line, book)
      const refused = await asAdmin()
        .post(ApiRoutes.finance.bank.lineRejections(line))
        .send({ journalLineId: book })
      expect(refused.status).toBe(CONFLICT)
      const open = await bookLine('out', 15151, day(-18))
      const second = await imported([`${day(-18)},Open,,-151.51`])
      const openLine = (await linesOf(second.id)).items[0]?.id ?? ''
      for (let times = 0; times < 2; times += 1) {
        await asAdmin()
          .post(ApiRoutes.finance.bank.lineRejections(openLine))
          .send({ journalLineId: open })
      }
      const rejection = await owner.reconciliationMatch.findFirstOrThrow({
        where: { statementLineId: openLine, status: 'rejected' }
      })
      await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_RECONCILIATION_REJECTED,
        resourceId: rejection.id
      })
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.FINANCE_RECONCILIATION_REJECTED, resourceId: rejection.id }
        })
      ).toBe(1)
    })

    it('name in the audit row of a bulk confirmation which line was paired with which', async () => {
      const book = await bookLine('out', 16161, day(-19), { documentNumber: 'DOC-16161' })
      const made = await imported([`${day(-19)},Bulk,DOC-16161,-161.61`])
      await asAdmin().post(ApiRoutes.finance.bank.confirmExact(made.id))
      const [audit] = await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_RECONCILIATION_CONFIRMED,
        resourceType: FinanceResourceTypes.BANK_IMPORT,
        resourceId: made.id
      })
      const match = await owner.reconciliationMatch.findFirstOrThrow({
        where: { journalLineId: book, status: 'confirmed' }
      })
      expect(audit?.metadata).toMatchObject({
        confirmed: 1,
        matches: [{ id: match.id, statementLineId: match.statementLineId, journalLineId: book }]
      })
    })

    it('offer an unmatched line as a transaction to register, prefilled, and post nothing', async () => {
      const made = await imported([
        `${day(-11)},Bank fee,F-9,-3.25`,
        `${day(-11)},Interest,I-9,1.10`
      ])
      const [out, incoming] = (await linesOf(made.id)).items
      const entries = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })
      const fee = await asAdmin().get(ApiRoutes.finance.bank.lineRegisterDraft(out?.id ?? ''))
      expect(fee.status).toBe(OK)
      expect(fee.body).toEqual({
        kind: 'expense',
        occurredOn: day(-11),
        amountCents: 325,
        fromAccountId: accounts[BANK],
        documentNumber: 'F-9'
      })
      // the bank's text becomes the memo only when the person asks for it
      const withMemo = await asAdmin().get(
        `${ApiRoutes.finance.bank.lineRegisterDraft(out?.id ?? '')}?useDescriptionAsMemo=true`
      )
      expect(withMemo.body).toMatchObject({ documentNumber: 'F-9', memo: 'Bank fee' })
      const refused = await asAdmin().get(
        `${ApiRoutes.finance.bank.lineRegisterDraft(out?.id ?? '')}?useDescriptionAsMemo=yes`
      )
      expect(refused.status).toBe(BAD_REQUEST)
      const interest = await asAdmin().get(
        ApiRoutes.finance.bank.lineRegisterDraft(incoming?.id ?? '')
      )
      expect(interest.body).toMatchObject({
        kind: 'income',
        toAccountId: accounts[BANK],
        amountCents: 110
      })
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        entries
      )
      // a matched line is not registered again
      const book = await bookLine('out', 325, day(-11))
      await confirm(out?.id ?? '', book)
      const matched = await asAdmin().get(ApiRoutes.finance.bank.lineRegisterDraft(out?.id ?? ''))
      expect(matched.status).toBe(CONFLICT)
      expect(conflictOf(matched.body)).toBe(FinanceConflicts.BANK_LINE_MATCHED)
    })
  })

  describe('the state and the difference with the statement', () => {
    it('says by account and month how many lines have their pair, and when every one does', async () => {
      const month = new Date(Date.UTC(2021, 2, 10))
      const date = month.toISOString().slice(0, 10)
      const book = await bookLine('in', 88888, date)
      const made = await imported([`${date},Month,,888.88`])
      const query = `?accountId=${accounts[BANK]}&year=2021&month=3`
      const before = await asAdmin().get(`${ApiRoutes.finance.bank.status}${query}`)
      expect(before.status).toBe(OK)
      expect(before.body).toMatchObject({
        book: { lines: 1, matched: 0, unmatched: 1, unmatchedCents: 88888 },
        statement: { lines: 1, matched: 0, unmatched: 1, unmatchedCents: 88888 },
        reconciled: false
      })
      await confirm((await linesOf(made.id)).items[0]?.id ?? '', book)
      const after = await asAdmin().get(`${ApiRoutes.finance.bank.status}${query}`)
      expect(after.body).toMatchObject({
        book: { matched: 1, unmatched: 0 },
        statement: { matched: 1, unmatched: 0 },
        reconciled: true
      })
      const notCash = await asAdmin().get(
        `${ApiRoutes.finance.bank.status}?accountId=${accounts[SERVICES]}&year=2021&month=3`
      )
      expect(notCash.status).toBe(CONFLICT)
    })

    it('compares the balance of the books with the closing balance of the statement and says what is left unexplained', async () => {
      const date = '2022-05-10'
      await bookLine('in', 100000, date)
      await bookLine('out', 2500, date)
      const made = await imported(
        [`${date},Deposit,,1000.00`, `${date},Bank charge,,-5.00`],
        profile.id,
        `&closingBalanceCents=99500&closingOn=${date}`
      )
      const response = await asAdmin().get(ApiRoutes.finance.bank.difference(made.id))
      expect(response.status).toBe(OK)
      const body = response.body as Record<string, unknown> & {
        unmatchedStatement: { lines: number; cents: number }
        unmatchedBook: { lines: number; cents: number }
      }
      // the balance is of the whole account up to the day, so it is read back from the books, not assumed
      const expected = await owner.journalLine.aggregate({
        where: {
          organizationId: ctx.orgA.id,
          accountId: accounts[BANK],
          entry: { entryDate: { lte: new Date(`${date}T00:00:00Z`) } }
        },
        _sum: { debitCents: true, creditCents: true }
      })
      const book = (expected._sum.debitCents ?? 0) - (expected._sum.creditCents ?? 0)
      expect(body['bookBalanceCents']).toBe(book)
      expect(body['statementBalanceCents']).toBe(99500)
      expect(body['differenceCents']).toBe(99500 - book)
      expect(body['unexplainedCents']).toBe(
        99500 - book - (body.unmatchedStatement.cents - body.unmatchedBook.cents)
      )
      const noBalance = await imported([`${date},No balance,,1.00`])
      const none = await asAdmin().get(ApiRoutes.finance.bank.difference(noBalance.id))
      expect(none.status).toBe(CONFLICT)
      expect(conflictOf(none.body)).toBe(FinanceConflicts.BANK_NO_CLOSING_BALANCE)
      const half = await send(
        `${HEADER}\n${date},Half,,1.00\n`,
        profile.id,
        '&closingOn=2022-05-10'
      )
      expect(half.status).toBe(BAD_REQUEST)
    })
  })

  describe('isolation and permissions', () => {
    it('hide an import, its lines and its decisions from another organization: the same 404 as for what does not exist', async () => {
      const book = await bookLine('out', 99999, day(-2))
      const made = await imported([`${day(-2)},Private,,-999.99`])
      const line = (await linesOf(made.id)).items[0]?.id ?? ''
      const ok = await confirm(line, book)
      const matchId = (ok.body as LineBody).match?.id ?? ''
      const asB = () => api(app, ctx.adminB, ctx.storeB)
      const missing = randomUUID()
      const calls: [supertest.Test, supertest.Test][] = [
        [
          asB().get(ApiRoutes.finance.bank.importById(made.id)),
          asB().get(ApiRoutes.finance.bank.importById(missing))
        ],
        [
          asB().get(ApiRoutes.finance.bank.importLines(made.id)),
          asB().get(ApiRoutes.finance.bank.importLines(missing))
        ],
        [
          asB().post(ApiRoutes.finance.bank.confirmExact(made.id)),
          asB().post(ApiRoutes.finance.bank.confirmExact(missing))
        ],
        [
          asB().get(ApiRoutes.finance.bank.difference(made.id)),
          asB().get(ApiRoutes.finance.bank.difference(missing))
        ],
        [
          asB().get(ApiRoutes.finance.bank.lineRegisterDraft(line)),
          asB().get(ApiRoutes.finance.bank.lineRegisterDraft(missing))
        ],
        [
          asB().post(ApiRoutes.finance.bank.matchUndo(matchId)),
          asB().post(ApiRoutes.finance.bank.matchUndo(missing))
        ],
        [
          asB().post(ApiRoutes.finance.bank.lineRejections(line)).send({ journalLineId: book }),
          asB().post(ApiRoutes.finance.bank.lineRejections(missing)).send({ journalLineId: book })
        ],
        [
          asB().post(ApiRoutes.finance.bank.lineMatches(line)).send({ journalLineId: book }),
          asB().post(ApiRoutes.finance.bank.lineMatches(missing)).send({ journalLineId: book })
        ]
      ]
      for (const [real, absent] of calls) {
        const [a, b] = await Promise.all([real, absent])
        expect([a.status, codeOf(a.body)]).toEqual([NOT_FOUND, codeOf(b.body)])
        expect(b.status).toBe(NOT_FOUND)
      }
      const statusB = await asB().get(
        `${ApiRoutes.finance.bank.status}?accountId=${accounts[BANK]}&year=2021&month=3`
      )
      expect(statusB.status).toBe(NOT_FOUND)
      const imports = await asB().get(ApiRoutes.finance.bank.imports)
      expect((imports.body as ImportBody[]).map(item => item.id)).not.toContain(made.id)
    })

    it('ask for the permission to reconcile on every route, and the journal permission is not it', async () => {
      const asReader = () => api(app, journalReader, ctx.storeA)
      const someId = randomUUID()
      const answers = await Promise.all([
        asReader().get(ApiRoutes.finance.bank.profiles),
        asReader().get(ApiRoutes.finance.bank.imports),
        asReader().get(ApiRoutes.finance.bank.importLines(someId)),
        asReader().post(ApiRoutes.finance.bank.confirmExact(someId)),
        asReader().get(ApiRoutes.finance.bank.difference(someId)),
        asReader().get(`${ApiRoutes.finance.bank.status}?accountId=${someId}&year=2026&month=1`),
        asReader().post(ApiRoutes.finance.bank.lineMatches(someId)).send({ journalLineId: someId }),
        asReader().post(ApiRoutes.finance.bank.matchUndo(someId)),
        asReader().get(ApiRoutes.finance.bank.lineRegisterDraft(someId))
      ])
      for (const answer of answers) {
        expect(answer.status).toBe(FORBIDDEN)
        expect(codeOf(answer.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      }
      const read = await asReconciler().get(ApiRoutes.finance.bank.imports)
      expect(read.status).toBe(OK)
    })
  })

  describe('what the database holds whoever writes', () => {
    it('keeps an import and its lines for ever and lets a decision only be taken back, once', async () => {
      const book = await bookLine('out', 11111, day(-13))
      const made = await imported([`${day(-13)},Held,,-111.11`])
      const line = await owner.bankStatementLine.findFirstOrThrow({ where: { importId: made.id } })
      await expect(
        owner.bankStatementLine.update({ where: { id: line.id }, data: { amountCents: 1 } })
      ).rejects.toThrow(/BANK_STATEMENT_IMMUTABLE/)
      await expect(owner.bankStatementLine.delete({ where: { id: line.id } })).rejects.toThrow(
        /BANK_STATEMENT_IMMUTABLE/
      )
      await expect(
        owner.bankStatementImport.update({ where: { id: made.id }, data: { lineCount: 9 } })
      ).rejects.toThrow(/BANK_STATEMENT_IMMUTABLE/)
      const ok = await confirm(line.id, book)
      const matchId = (ok.body as LineBody).match?.id ?? ''
      await expect(owner.reconciliationMatch.delete({ where: { id: matchId } })).rejects.toThrow(
        /RECONCILIATION_MATCH/
      )
      await expect(
        owner.reconciliationMatch.update({ where: { id: matchId }, data: { decidedBy: 'someone' } })
      ).rejects.toThrow(/RECONCILIATION_MATCH/)
      // the second confirmed match of the same journal line is refused by the unique index, not only by the service
      const second = await imported([`${day(-13)},Second,,-111.11`])
      const secondLine = await owner.bankStatementLine.findFirstOrThrow({
        where: { importId: second.id }
      })
      await expect(
        owner.reconciliationMatch.create({
          data: {
            organizationId: ctx.orgA.id,
            statementLineId: secondLine.id,
            journalLineId: book,
            status: 'confirmed',
            decidedBy: ctx.adminA.id
          }
        })
      ).rejects.toThrow()
    })

    it('refuses a confirmed pair of other amounts, of another account, of a reversed entry or of its reversal', async () => {
      const book = await bookLine('out', 12121, day(-14))
      const cashLine = await bookLineOnCash(12121, day(-14))
      const made = await imported([`${day(-14)},Rules,,-121.21`, `${day(-14)},Amount,,-121.22`])
      const [ok, wrongAmount] = await owner.bankStatementLine.findMany({
        where: { importId: made.id },
        orderBy: { lineNo: 'asc' }
      })
      const insert = (statementLineId: string, journalLineId: string) =>
        owner.reconciliationMatch.create({
          data: {
            organizationId: ctx.orgA.id,
            statementLineId,
            journalLineId,
            status: 'confirmed',
            decidedBy: ctx.adminA.id
          }
        })
      await expect(insert(wrongAmount?.id ?? '', book)).rejects.toThrow(/not the same movement/)
      await expect(insert(ok?.id ?? '', cashLine)).rejects.toThrow(/same account/)
      await expect(insert(ok?.id ?? '', randomUUID())).rejects.toThrow()
      // a voided transaction: its entry and the reversal are both out
      const voidedBook = await bookLine('out', 12121, day(-14))
      const voidedTransaction = await owner.financeTransaction.findFirstOrThrow({
        where: { entry: { lines: { some: { id: voidedBook } } } }
      })
      await asAdmin()
        .post(ApiRoutes.finance.transactions.void(voidedTransaction.id))
        .send({ reason: 'Gone' })
      await expect(insert(ok?.id ?? '', voidedBook)).rejects.toThrow(/reversed entry/)
      const reversal = await owner.journalLine.findFirstOrThrow({
        where: { entry: { reversesEntryId: voidedTransaction.entryId }, accountId: accounts[BANK] }
      })
      await expect(insert(ok?.id ?? '', reversal.id)).rejects.toThrow()
    })

    it('holds a profile to a cash account of its own organization', async () => {
      await expect(
        owner.bankImportProfile.create({
          data: {
            organizationId: ctx.orgA.id,
            accountId: accountsB[BANK] ?? '',
            name: 'crossed',
            columns: { date: 'Date', amount: 'Amount' },
            createdBy: ctx.adminA.id
          }
        })
      ).rejects.toThrow()
      await expect(
        owner.bankImportProfile.create({
          data: {
            organizationId: ctx.orgA.id,
            accountId: accounts[SERVICES] ?? '',
            name: 'not cash',
            columns: { date: 'Date', amount: 'Amount' },
            createdBy: ctx.adminA.id
          }
        })
      ).rejects.toThrow(/BANK_PROFILE/)
    })
  })

  // The file of a bank that prints a time after the day on most rows, thousands with a comma inside quotes, and no header row
  // (synthetic: only the shape of a real statement; a day past the 12th, so the order of the day and the month is not asked). Its own account, so the lines of the other cases are not in its way.
  describe('one statement line against several lines of the books (HC-121)', () => {
    const group = (lineId: string, journalLineIds: string[], who = asAdmin) =>
      who().post(ApiRoutes.finance.bank.lineGroupMatches(lineId)).send({ journalLineIds })
    const lineOf = async (importId: string) =>
      owner.bankStatementLine.findFirstOrThrow({ where: { importId } })
    const confirmedOf = (lineId: string) =>
      owner.reconciliationMatch.findMany({
        where: { statementLineId: lineId, status: 'confirmed' },
        select: { id: true, journalLineId: true, groupId: true }
      })

    it('confirms a deposit that groups three collections, and the books are untouched', async () => {
      const [a, b, c] = [
        await bookLine('in', 50_000, day(-4)),
        await bookLine('in', 60_000, day(-3)),
        await bookLine('in', 40_000, day(-2))
      ]
      const made = await imported([`${day(-2)},Grouped deposit,,1500.00`])
      const line = await lineOf(made.id)
      const entriesBefore = await owner.journalEntry.count({
        where: { organizationId: ctx.orgA.id }
      })

      const ok = await group(line.id, [c, a, b])

      expect(ok.status).toBe(CREATED)
      const body = ok.body as LineBody
      expect(body.match).not.toBeNull()
      expect(body.group?.pieces.map(piece => piece.journalLineId).sort()).toEqual([a, b, c].sort())
      expect(body.group?.pieces.reduce((total, piece) => total + piece.signedCents, 0)).toBe(
        150_000
      )
      const rows = await confirmedOf(line.id)
      expect(rows).toHaveLength(3)
      expect(new Set(rows.map(row => row.groupId)).size).toBe(1)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        entriesBefore
      )
      expect((await linesOf(made.id)).counts).toMatchObject({ matched: 1, unmatched: 0 })
      await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_RECONCILIATION_GROUP_CONFIRMED,
        resourceType: FinanceResourceTypes.RECONCILIATION_MATCH,
        resourceId: body.match?.id ?? ''
      })
    })

    it('confirms a deposit net of a fee the person booked as an expense from the same account', async () => {
      const sale = await bookLine('in', 150_000, day(-3))
      const fee = await bookLine('out', 300, day(-3))
      const made = await imported([`${day(-2)},Net deposit,,1497.00`])
      const line = await lineOf(made.id)

      const ok = await group(line.id, [sale, fee])

      expect(ok.status).toBe(CREATED)
      expect((ok.body as LineBody).group?.pieces).toHaveLength(2)
    })

    it('refuses a group that is off by one cent, and writes nothing', async () => {
      const [a, b] = [await bookLine('in', 60_000, day(-3)), await bookLine('in', 39_999, day(-3))]
      const made = await imported([`${day(-2)},Short,,1000.00`])
      const line = await lineOf(made.id)

      const refused = await group(line.id, [a, b])

      expect(refused.status).toBe(CONFLICT)
      expect(conflictOf(refused.body)).toBe(FinanceConflicts.BANK_GROUP_SUM_MISMATCH)
      expect((refused.body as ErrorBody).error.metadata).toMatchObject({
        statementCents: 100_000,
        sumCents: 99_999
      })
      expect(await confirmedOf(line.id)).toHaveLength(0)
    })

    it('refuses a group of one, a line named twice, a line of another account and a line that does not exist', async () => {
      const [a, b] = [await bookLine('in', 600, day(-3)), await bookLine('in', 400, day(-3))]
      const cash = await bookLineOnCash(400, day(-3))
      const made = await imported([`${day(-2)},Small,,10.00`])
      const line = await lineOf(made.id)

      expect((await group(line.id, [a])).status).toBe(BAD_REQUEST)
      const twice = await group(line.id, [a, a])
      expect(twice.status).toBe(CONFLICT)
      expect(conflictOf(twice.body)).toBe(FinanceConflicts.BANK_GROUP_NOT_ALLOWED)
      expect((await group(line.id, [a, cash])).status).toBe(NOT_FOUND)
      expect((await group(line.id, [a, randomUUID()])).status).toBe(NOT_FOUND)
      expect((await group(randomUUID(), [a, b])).status).toBe(NOT_FOUND)
      expect(await confirmedOf(line.id)).toHaveLength(0)
    })

    it('refuses a line that is matched already, and a line of the books that is matched already', async () => {
      const [a, b, c] = [
        await bookLine('in', 600, day(-3)),
        await bookLine('in', 400, day(-3)),
        await bookLine('in', 1000, day(-3))
      ]
      const made = await imported([`${day(-2)},First,,10.00`, `${day(-2)},Second,,20.00`])
      const [first, second] = (await linesOf(made.id)).items
      expect((await confirm(first?.id ?? '', c)).status).toBe(CREATED)
      expect((await group(first?.id ?? '', [a, b])).status).toBe(CONFLICT)
      // The line c is matched: it cannot be in a group of another line
      const other = await bookLine('in', 1000, day(-3))
      const taken = await group(second?.id ?? '', [c, other])
      expect(taken.status).toBe(CONFLICT)
      expect(await confirmedOf(second?.id ?? '')).toHaveLength(0)
    })

    it('is taken back whole from any of its decisions, and the line is open again', async () => {
      const [a, b] = [await bookLine('in', 700, day(-3)), await bookLine('in', 300, day(-3))]
      const made = await imported([`${day(-2)},Undo,,10.00`])
      const line = await lineOf(made.id)
      const ok = (await group(line.id, [a, b])).body as LineBody
      const piece = ok.group?.pieces[0]?.matchId ?? ''

      const undone = await asAdmin().post(ApiRoutes.finance.bank.matchUndo(piece)).send({})

      expect(undone.status).toBe(OK)
      expect((undone.body as LineBody).match).toBeNull()
      expect((undone.body as LineBody).group).toBeNull()
      expect(await confirmedOf(line.id)).toHaveLength(0)
      // Open again: it can be matched as a group once more
      expect((await group(line.id, [a, b])).status).toBe(CREATED)
    })

    it('lets exactly one of two groups win when two people decide the same line at the same moment', async () => {
      const [a, b, c, d] = [
        await bookLine('in', 40_000, day(-3)),
        await bookLine('in', 60_000, day(-3)),
        await bookLine('in', 30_000, day(-3)),
        await bookLine('in', 70_000, day(-3))
      ]
      const made = await imported([`${day(-2)},Race,,1000.00`])
      const line = await lineOf(made.id)

      const answers = await Promise.all([group(line.id, [a, b]), group(line.id, [c, d])])

      expect(answers.filter(answer => answer.status === CREATED)).toHaveLength(1)
      const refused = answers.find(answer => answer.status !== CREATED)
      expect(refused?.status).toBe(CONFLICT)
      expect([FinanceConflicts.BANK_LINE_ALREADY_MATCHED, FinanceConflicts.BANK_CHANGED]).toContain(
        conflictOf(refused?.body)
      )
      const rows = await confirmedOf(line.id)
      expect(rows).toHaveLength(2)
      expect(new Set(rows.map(row => row.groupId)).size).toBe(1)
    })

    it('keeps a group that straddles the closing day as a difference of that day, like a pair that does', async () => {
      const date = '2022-07-10'
      const [early, late] = [
        await bookLine('in', 60_000, date),
        await bookLine('in', 40_000, '2022-07-15')
      ]
      const made = await imported(
        [`${date},Straddle,,1000.00`],
        profile.id,
        `&closingBalanceCents=100000&closingOn=${date}`
      )
      const line = await lineOf(made.id)
      type Difference = {
        unmatchedStatement: { lines: number; cents: number }
        unmatchedBook: { lines: number; cents: number }
        unexplainedCents: number
      }
      const differenceOf = async (): Promise<Difference> =>
        (await asAdmin().get(ApiRoutes.finance.bank.difference(made.id))).body as Difference
      const before = await differenceOf()

      expect((await group(line.id, [early, late])).status).toBe(CREATED)

      // The line of the later day was not on the books at the closing day: the group is not matched at that day and nothing moves
      expect(await differenceOf()).toEqual(before)
    })

    it('does not reach the lines of another organization, and asks for the permission to reconcile', async () => {
      const [a, b] = [await bookLine('in', 700, day(-3)), await bookLine('in', 300, day(-3))]
      const made = await imported([`${day(-2)},Mine,,10.00`])
      const line = await lineOf(made.id)

      expect((await group(line.id, [a, b], () => api(app, ctx.adminB, ctx.storeB))).status).toBe(
        NOT_FOUND
      )
      expect((await group(line.id, [a, b], () => api(app, journalReader, ctx.storeA))).status).toBe(
        FORBIDDEN
      )
      expect((await group(line.id, [a, b], asReconciler)).status).toBe(CREATED)
    })

    describe('what the database holds whoever writes', () => {
      const rowOf = (
        lineId: string,
        journalLineId: string,
        groupId: string | null,
        isGroupLead = false
      ) => ({
        organizationId: ctx.orgA.id,
        statementLineId: lineId,
        journalLineId,
        status: 'confirmed',
        decidedBy: 'db-suite',
        groupId,
        isGroupLead
      })

      it('keeps a group that does not add up out of the books at the commit, in any order, and a group of one', async () => {
        const [a, b] = [await bookLine('in', 600, day(-3)), await bookLine('in', 399, day(-3))]
        const made = await imported([`${day(-2)},Strict,,10.00`])
        const line = await lineOf(made.id)
        const groupId = randomUUID()

        await expect(
          // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
          owner.$transaction(async tx => {
            await tx.reconciliationMatch.create({ data: rowOf(line.id, b, groupId, true) })
            await tx.reconciliationMatch.create({ data: rowOf(line.id, a, groupId) })
          })
        ).rejects.toThrow(/RECONCILIATION_GROUP/)
        await expect(
          owner.reconciliationMatch.create({ data: rowOf(line.id, a, randomUUID(), true) })
        ).rejects.toThrow(/RECONCILIATION_GROUP/)
        expect(await confirmedOf(line.id)).toHaveLength(0)
      })

      it('keeps a pair and a group, or two groups, of one statement line apart', async () => {
        const [a, b, c, d, e] = [
          await bookLine('in', 600, day(-3)),
          await bookLine('in', 400, day(-3)),
          await bookLine('in', 1000, day(-3)),
          await bookLine('in', 700, day(-3)),
          await bookLine('in', 300, day(-3))
        ]
        const made = await imported([`${day(-2)},Apart,,10.00`])
        const line = await lineOf(made.id)
        const first = randomUUID()
        // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
        await owner.$transaction(async tx => {
          await tx.reconciliationMatch.create({ data: rowOf(line.id, a, first, true) })
          await tx.reconciliationMatch.create({ data: rowOf(line.id, b, first) })
        })

        await expect(
          owner.reconciliationMatch.create({ data: rowOf(line.id, c, null) })
        ).rejects.toThrow(/matched by a group/)
        // A second group that is valid on its own (it adds up to the line) is refused all the same: the line has its group
        const second = randomUUID()
        await expect(
          // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
          owner.$transaction(async tx => {
            await tx.reconciliationMatch.create({ data: rowOf(line.id, d, second, true) })
            await tx.reconciliationMatch.create({ data: rowOf(line.id, e, second) })
          })
        ).rejects.toThrow(/statement line is matched already/)
        expect(await confirmedOf(line.id)).toHaveLength(2)
      })

      it('holds exactly one lead per group, and a group with none or two is not kept', async () => {
        const [a, b] = [await bookLine('in', 600, day(-3)), await bookLine('in', 400, day(-3))]
        const made = await imported([`${day(-2)},Lead,,10.00`])
        const line = await lineOf(made.id)

        for (const [leads, refusal] of [
          [[false, false], /RECONCILIATION_GROUP/],
          // Two leads of one statement line: the unique index of the confirmed decisions holds the second
          [[true, true], /Unique constraint|uq_reconciliation_confirmed_statement_line/]
        ] as const) {
          const groupId = randomUUID()
          await expect(
            // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
            owner.$transaction(async tx => {
              await tx.reconciliationMatch.create({ data: rowOf(line.id, a, groupId, leads[0]) })
              await tx.reconciliationMatch.create({ data: rowOf(line.id, b, groupId, leads[1]) })
            })
          ).rejects.toThrow(refusal)
        }
        expect(await confirmedOf(line.id)).toHaveLength(0)
      })

      it('takes a group back whole or not at all', async () => {
        const [a, b] = [await bookLine('in', 600, day(-3)), await bookLine('in', 400, day(-3))]
        const made = await imported([`${day(-2)},Whole,,10.00`])
        const line = await lineOf(made.id)
        const groupId = randomUUID()
        // eslint-disable-next-line no-restricted-syntax -- the owner client of the suite, not the tenant client of the app
        await owner.$transaction(async tx => {
          await tx.reconciliationMatch.create({ data: rowOf(line.id, a, groupId, true) })
          await tx.reconciliationMatch.create({ data: rowOf(line.id, b, groupId) })
        })
        const [one] = await confirmedOf(line.id)

        await expect(
          owner.reconciliationMatch.update({
            where: { id: one?.id ?? '' },
            data: { status: 'undone', undoneBy: 'db-suite', undoneAt: new Date() }
          })
        ).rejects.toThrow(/RECONCILIATION_GROUP/)
        expect(await confirmedOf(line.id)).toHaveLength(2)
        await owner.reconciliationMatch.updateMany({
          where: { groupId, status: 'confirmed' },
          data: { status: 'undone', undoneBy: 'db-suite', undoneAt: new Date() }
        })
        expect(await confirmedOf(line.id)).toHaveLength(0)
      })

      it('never gives a rejection to a group', async () => {
        const a = await bookLine('in', 600, day(-3))
        const made = await imported([`${day(-2)},Rejected,,6.00`])
        const line = await lineOf(made.id)

        await expect(
          owner.reconciliationMatch.create({
            data: { ...rowOf(line.id, a, randomUUID()), status: 'rejected' }
          })
        ).rejects.toThrow(/chk_reconciliation_group/)
      })
    })
  })

  describe('a statement with a time in its dates and quoted thousands', () => {
    const rows = {
      first: [
        '14/11/2026 10:00:00,Deposit,R1,0.00,"1,234.50"',
        '14/11/2026 11:00:00,Deposit,R1,0.00,"1,234.50"',
        '15/11/2026,Fee,R2,2.00,0.00'
      ],
      // Starts in the middle of the 14 November: it brings again the 11:00 line, with its time, and the day-only line
      overlap: [
        '14/11/2026 11:00:00,Deposit,R1,0.00,"1,234.50"',
        '15/11/2026,Fee,R2,2.00,0.00',
        '16/11/2026 08:30:00,Payment,R3,"10,000.00",0.00'
      ]
    }
    let bank: ProfileBody
    beforeAll(async () => {
      bank = await makeProfile(accounts[CASH] ?? '', 'timed', {
        hasHeader: false,
        thousandsSeparator: 'comma',
        dateFormat: 'dd/MM/yyyy',
        columns: { date: 0, description: 1, reference: 2, debit: 3, credit: 4 }
      })
    })
    const post = (lines: string[]) => send(`${lines.join('\n')}\n`, bank.id)

    it('reads the amounts with the comma and the times, and keeps two equal movements of different times as two lines', async () => {
      const response = await post(rows.first)
      expect(response.status).toBe(CREATED)
      const body = response.body as ImportBody
      expect(body.lineCount).toBe(3)
      expect(body.newLineCount).toBe(3)
      const page = await linesOf(body.id)
      expect(page.items.map(line => line.amountCents).sort((a, b) => a - b)).toEqual([
        -200, 123450, 123450
      ])
    })

    it('does not double the lines that an overlapping statement repeats', async () => {
      // The first statement is there whichever case ran before (a repeat of it answers 409: nothing new)
      await post(rows.first)
      const response = await post(rows.overlap)
      expect(response.status).toBe(CREATED)
      const body = response.body as ImportBody
      expect(body.lineCount).toBe(3)
      // Only the 16 November payment is new: the 11:00 line has its time and the fee its day alone, both known
      expect(body.newLineCount).toBe(1)
      const again = await post(rows.overlap)
      expect(again.status).toBe(CONFLICT)
      expect(conflictOf(again.body)).toBe(FinanceConflicts.BANK_IMPORT_NOTHING_NEW)
    })

    it('refuses a thousands separator that is not quoted, and a time that does not exist, naming the row', async () => {
      const before = await owner.bankStatementLine.count({ where: { accountId: accounts[CASH] } })
      const loose = await post([...rows.first, '17/11/2026 09:00:00,Deposit,R9,0.00,1,234.50'])
      expect(loose.status).toBe(BAD_REQUEST)
      const late = await post(['17/11/2026 25:00:00,Deposit,R9,0.00,5.00', ...rows.first])
      expect(late.status).toBe(BAD_REQUEST)
      // A refused file keeps nothing, not even its good rows
      expect(await owner.bankStatementLine.count({ where: { accountId: accounts[CASH] } })).toBe(
        before
      )
    })
  })

  // A bank that prints a lead of report lines before the movements: the profile says how many records to skip
  describe('a statement that starts with a lead of report lines', () => {
    const lead = [
      ',,,Statement of account,,',
      ',,,"Period\nfrom a day to a day",,',
      ',,,,,',
      'Opening balance:,,,,,100.00',
      ',,,,,',
      ',Date,Memo,Ref,Debit,Credit'
    ]
    const movements = [
      '19/11/2026 10:15:30,Deposit,R1,0.00,"1,234.50"',
      '20/11/2026,Fee,R2,2.00,0.00'
    ].map(line => `,${line}`)
    const text = `${[...lead, ...movements].join('\n')}\n`
    let skipping: ProfileBody
    beforeAll(async () => {
      // 5 records that are not blank: the title, the multi line title, the balance, and the row of titles (4); the blank ones are not
      skipping = await makeProfile(accounts['1102'] ?? '', 'lead', {
        hasHeader: false,
        skipRows: 4,
        thousandsSeparator: 'comma',
        dateFormat: 'dd/MM/yyyy',
        columns: { date: 1, description: 2, reference: 3, debit: 4, credit: 5 }
      })
    })

    it('keeps the rows to skip in the profile, and a profile made without them skips none', async () => {
      const read = await asAdmin().get(
        `${ApiRoutes.finance.bank.profiles}?accountId=${accounts['1102']}`
      )
      expect(read.status).toBe(OK)
      const mine = (read.body as { id: string; skipRows: number }[]).find(
        item => item.id === skipping.id
      )
      expect(mine?.skipRows).toBe(4)
      const plain = await makeProfile(accounts['1102'] ?? '', 'plain')
      expect((plain as ProfileBody & { skipRows: number }).skipRows).toBe(0)
    })

    it('refuses the rows to skip out of range, on a new profile and on a change', async () => {
      const body = {
        accountId: accounts['1102'],
        name: `range-${randomUUID().slice(0, 6)}`,
        columns: { date: 'Date', amount: 'Amount' }
      }
      expect(
        (
          await asAdmin()
            .post(ApiRoutes.finance.bank.profiles)
            .send({ ...body, skipRows: 51 })
        ).status
      ).toBe(BAD_REQUEST)
      expect(
        (
          await asAdmin()
            .post(ApiRoutes.finance.bank.profiles)
            .send({ ...body, skipRows: -1 })
        ).status
      ).toBe(BAD_REQUEST)
      const changed = await asAdmin()
        .patch(ApiRoutes.finance.bank.profileById(skipping.id))
        .send({ skipRows: 99 })
      expect(changed.status).toBe(BAD_REQUEST)
      const ok = await asAdmin()
        .patch(ApiRoutes.finance.bank.profileById(skipping.id))
        .send({ skipRows: 4 })
      expect(ok.status).toBe(OK)
    })

    it('previews the movements and not the lead, and imports them', async () => {
      const preview = await asAdmin()
        .post(ApiRoutes.finance.bank.profilePreview)
        .send({
          text,
          profile: {
            delimiter: ',',
            hasHeader: false,
            skipRows: 4,
            decimalSeparator: '.',
            thousandsSeparator: 'comma',
            dateFormat: 'dd/MM/yyyy',
            columns: { date: 1, description: 2, reference: 3, debit: 4, credit: 5 }
          }
        })
      expect(preview.status).toBe(OK)
      expect((preview.body as { errorCount: number; lines: unknown[] }).errorCount).toBe(0)
      expect((preview.body as { lines: unknown[] }).lines).toHaveLength(2)
      const response = await send(text, skipping.id)
      expect(response.status).toBe(CREATED)
      expect((response.body as ImportBody).lineCount).toBe(2)
    })

    it('refuses the same file with a profile that skips none, naming the rows, and keeps nothing', async () => {
      const before = await owner.bankStatementLine.count({ where: { accountId: accounts['1102'] } })
      const plain = await makeProfile(accounts['1102'] ?? '', 'plain-refuse', {
        hasHeader: false,
        thousandsSeparator: 'comma',
        dateFormat: 'dd/MM/yyyy',
        columns: { date: 1, description: 2, reference: 3, debit: 4, credit: 5 }
      })
      const refused = await send(text, plain.id)
      expect(refused.status).toBe(BAD_REQUEST)
      expect(codeOf(refused.body)).toBe(ErrorCodes.BANK_STATEMENT_INVALID)
      expect(await owner.bankStatementLine.count({ where: { accountId: accounts['1102'] } })).toBe(
        before
      )
    })
  })

  async function bookLineOnCash(amountCents: number, occurredOn: string): Promise<string> {
    const response = await asAdmin()
      .post(ApiRoutes.finance.transactions.record)
      .send({
        idempotencyKey: `k${randomUUID().replaceAll('-', '')}`,
        kind: FinanceTransactionKind.EXPENSE,
        occurredOn,
        amountCents,
        fromAccountId: accounts[CASH],
        categoryAccountId: accounts[SERVICES]
      })
    expect(response.status).toBe(CREATED)
    const transaction = await owner.financeTransaction.findFirstOrThrow({
      where: { id: (response.body as { id: string }).id }
    })
    return (
      await owner.journalLine.findFirstOrThrow({
        where: { entryId: transaction.entryId, accountId: accounts[CASH] }
      })
    ).id
  }
})
