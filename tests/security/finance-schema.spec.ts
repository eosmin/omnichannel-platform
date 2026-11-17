import { Permissions, RoleNames, RolePresets } from '@platform/core/auth'
import {
  connectionUrls,
  createOwnerClient,
  ensureStore,
  type OwnerClient
} from '@platform/core/database-testing'
import {
  AccountRole,
  AccountType,
  BankStatementEncodings,
  BankStatementLimits,
  BankThousandsSeparators,
  CashKind,
  ChainProblem,
  EntryOrigin,
  FinanceSourceType,
  JournalEntryType,
  NormalSide,
  PartyType,
  PeriodStatus,
  ReconciliationMatchStatus,
  RemittanceDateFormats,
  SaleRecognition
} from '@platform/core/domain'
import { type ChainEntry, verifyChain } from '@platform/core/finance-hash'

import {
  createFinanceFixture,
  createPeriod,
  day,
  type FinanceFixture,
  postTestEntry,
  simpleEntry
} from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// What the database itself guarantees about the books (TDD_18 §2, §9.2), before any service writes to them: the rules the
// ledger stands on, so that a bug of a service cannot break them. Each case writes as the owner of the database, which no
// privilege holds back: what refuses it is the table itself. The routes that read and write the ledger, and their isolation
// cases, arrive with the second PR of Step 4B.2.
describe('The tables of the ledger', () => {
  const prefix = newRunPrefix()
  let owner: OwnerClient
  let orgA: { id: string }
  let orgB: { id: string }
  let a: FinanceFixture
  let b: FinanceFixture
  let storeA: { id: string }
  let storeB: { id: string }

  beforeAll(async () => {
    owner = ownerClient()
    orgA = await owner.organization.create({ data: { name: `${prefix}-a`, slug: `${prefix}-a` } })
    orgB = await owner.organization.create({ data: { name: `${prefix}-b`, slug: `${prefix}-b` } })
    storeA = await ensureStore(owner, orgA.id, `${prefix}-store-a`)
    storeB = await ensureStore(owner, orgB.id, `${prefix}-store-b`)
    a = await createFinanceFixture(owner, orgA.id)
    b = await createFinanceFixture(owner, orgB.id)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.$disconnect()
  })

  // What the database says when it refuses: the code or the name of the constraint is in the message
  const refused = (statement: Promise<unknown>, reason: string | RegExp) =>
    expect(statement).rejects.toThrow(reason)

  const headOf = (organizationId: string) =>
    owner.financeSettings.findUniqueOrThrow({ where: { organizationId } })

  describe('an entry', () => {
    it('posts balanced, and moves the counter and the head of the chain with it', async () => {
      const before = await headOf(orgA.id)
      const entry = await postTestEntry(owner, simpleEntry(a, 2500))
      const after = await headOf(orgA.id)
      expect(entry.number).toBe(before.nextEntryNumber)
      expect(entry.totalCents).toBe(2500)
      expect(entry.lines).toHaveLength(2)
      expect(after.nextEntryNumber).toBe(before.nextEntryNumber + 1n)
      expect(after.lastEntryHash).toBe(entry.hash)
    })

    it('is refused at commit when the debits and the credits differ', async () => {
      const before = await headOf(orgA.id)
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: 1000 },
            { accountId: a.accounts.cash, creditCents: 999 }
          ]
        }),
        'FINANCE_ENTRY_UNBALANCED'
      )
      // The refused entry took no number and moved no head
      expect(await headOf(orgA.id)).toMatchObject({
        nextEntryNumber: before.nextEntryNumber,
        lastEntryHash: before.lastEntryHash
      })
    })

    it('is refused with fewer than two lines, with no lines, and with a total that is not its sum', async () => {
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [{ accountId: a.accounts.expense, debitCents: 1000 }]
        }),
        'FINANCE_ENTRY_UNBALANCED'
      )
      await refused(
        postTestEntry(owner, { ...simpleEntry(a), lines: [] }),
        'FINANCE_ENTRY_UNBALANCED'
      )
      await refused(
        postTestEntry(owner, { ...simpleEntry(a), override: { totalCents: 1001 } }),
        'FINANCE_ENTRY_UNBALANCED'
      )
    })

    it('is refused when its lines are not exactly one side each', async () => {
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: 500, creditCents: 500 },
            { accountId: a.accounts.cash, creditCents: 1 },
            { accountId: a.accounts.cash, debitCents: 1 }
          ]
        }),
        'chk_journal_lines_one_side'
      )
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: 0 },
            { accountId: a.accounts.cash, creditCents: 0 }
          ]
        }),
        'chk_journal_lines_one_side'
      )
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: -5 },
            { accountId: a.accounts.cash, creditCents: -5 }
          ]
        }),
        'chk_journal_lines_one_side'
      )
    })

    it('cannot be given more lines later, not even a balanced pair', async () => {
      const entry = await postTestEntry(owner, simpleEntry(a, 700))
      await refused(
        owner.journalLine.createMany({
          data: [
            {
              entryId: entry.id,
              organizationId: orgA.id,
              accountId: a.accounts.expense,
              debitCents: 50,
              lineNo: 3
            },
            {
              entryId: entry.id,
              organizationId: orgA.id,
              accountId: a.accounts.cash,
              creditCents: 50,
              lineNo: 4
            }
          ]
        }),
        'FINANCE_ENTRY_UNBALANCED'
      )
    })

    it('keeps the key of a request once per organization, and lets another organization use it', async () => {
      const key = `${prefix}:order:1:sale`
      await postTestEntry(owner, simpleEntry(a, 100, { idempotencyKey: key }))
      await refused(
        postTestEntry(owner, simpleEntry(a, 100, { idempotencyKey: key })),
        /idempotency_key/
      )
      await expect(
        postTestEntry(owner, simpleEntry(b, 100, { idempotencyKey: key }))
      ).resolves.toMatchObject({ idempotencyKey: key })
    })

    it('carries a manual entry with its author, and a system one without', async () => {
      await expect(
        postTestEntry(
          owner,
          simpleEntry(a, 10, {
            type: JournalEntryType.MANUAL,
            origin: EntryOrigin.USER,
            createdBy: 'user-1',
            memo: 'adjustment'
          })
        )
      ).resolves.toMatchObject({ createdBy: 'user-1' })
      await refused(
        postTestEntry(owner, simpleEntry(a, 10, { origin: EntryOrigin.USER, createdBy: null })),
        'chk_journal_entries_author'
      )
      await refused(
        postTestEntry(owner, simpleEntry(a, 10, { origin: EntryOrigin.SYSTEM, createdBy: 'u' })),
        'chk_journal_entries_author'
      )
    })
  })

  describe('the accounts of the lines', () => {
    it('must take entries: a header refuses them', async () => {
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.header, debitCents: 5 },
            { accountId: a.accounts.cash, creditCents: 5 }
          ]
        }),
        'FINANCE_ACCOUNT_NOT_POSTABLE'
      )
    })

    it('must be active', async () => {
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.inactive, debitCents: 5 },
            { accountId: a.accounts.cash, creditCents: 5 }
          ]
        }),
        'FINANCE_ACCOUNT_INACTIVE'
      )
    })

    it('may be inactive for the reversal of an entry that used it, and for nothing else', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-in`, slug: `${prefix}-in` }
      })
      const f = await createFinanceFixture(owner, org.id)
      const used = await owner.ledgerAccount.create({
        data: {
          organizationId: org.id,
          code: '6200',
          name: 'Usada',
          type: AccountType.EXPENSE,
          normalSide: NormalSide.DEBIT
        }
      })
      const original = await postTestEntry(owner, {
        ...simpleEntry(f, 90),
        lines: [
          { accountId: used.id, debitCents: 90 },
          { accountId: f.accounts.cash, creditCents: 90 }
        ]
      })
      await owner.ledgerAccount.update({ where: { id: used.id }, data: { active: false } })
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(f, 5),
          lines: [
            { accountId: used.id, debitCents: 5 },
            { accountId: f.accounts.cash, creditCents: 5 }
          ]
        }),
        'FINANCE_ACCOUNT_INACTIVE'
      )
      await expect(
        postTestEntry(owner, {
          organizationId: org.id,
          periodId: f.periodId,
          type: JournalEntryType.REVERSAL,
          reversesEntryId: original.id,
          lines: [
            { accountId: used.id, creditCents: 90 },
            { accountId: f.accounts.cash, debitCents: 90 }
          ]
        })
      ).resolves.toMatchObject({ reversesEntryId: original.id })
    })

    it('must be of the organization of the entry, and so must the store of a line', async () => {
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: b.accounts.expense, debitCents: 5 },
            { accountId: a.accounts.cash, creditCents: 5 }
          ]
        }),
        /FINANCE_ACCOUNT_NOT_POSTABLE|journal_lines_organization_id_account_id_fkey/
      )
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: 5, storeId: storeB.id },
            { accountId: a.accounts.cash, creditCents: 5 }
          ]
        }),
        'journal_lines_organization_id_store_id_fkey'
      )
      // The store of the organization is a dimension that is accepted
      await expect(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: 5, storeId: storeA.id },
            { accountId: a.accounts.cash, creditCents: 5, storeId: storeA.id }
          ]
        })
      ).resolves.toBeDefined()
    })

    it('refuse a party that is only half there', async () => {
      await refused(
        postTestEntry(owner, {
          ...simpleEntry(a),
          lines: [
            { accountId: a.accounts.expense, debitCents: 5, partyType: 'supplier' },
            { accountId: a.accounts.cash, creditCents: 5 }
          ]
        }),
        'chk_journal_lines_party'
      )
    })
  })

  describe('the period of an entry', () => {
    it('must be open: a closed period refuses it', async () => {
      const closed = await createPeriod(owner, orgA.id, 2026, 9, PeriodStatus.CLOSED)
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { periodId: closed, entryDate: '2026-09-15' })),
        'FINANCE_PERIOD_CLOSED'
      )
    })

    it('must be after the lock of the books, even an open period before the last closed one', async () => {
      const july = await createPeriod(owner, orgB.id, 2026, 7)
      const august = await createPeriod(owner, orgB.id, 2026, 8, PeriodStatus.CLOSED)
      await owner.financeSettings.update({
        where: { organizationId: orgB.id },
        data: { lockedThrough: day('2026-08-31') }
      })
      try {
        await refused(
          postTestEntry(owner, simpleEntry(b, 5, { periodId: july, entryDate: '2026-07-20' })),
          'FINANCE_PERIOD_CLOSED'
        )
      } finally {
        await owner.fiscalPeriod.update({
          where: { id: august },
          data: {
            status: PeriodStatus.OPEN,
            reopenedAt: new Date(),
            reopenedBy: 'test-user',
            reopenReason: 'test'
          }
        })
        await owner.financeSettings.update({
          where: { organizationId: orgB.id },
          data: { lockedThrough: null }
        })
      }
    })

    it('locks every day up to the end of a closed period, even when the lock was not moved', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-lk`, slug: `${prefix}-lk` }
      })
      const f = await createFinanceFixture(owner, org.id)
      const october = await createPeriod(owner, org.id, 2026, 10)
      // November is closed with a plain update of its status: the lock of the settings stays where it was
      await owner.fiscalPeriod.update({
        where: { id: f.periodId },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: 'u' }
      })
      await refused(
        postTestEntry(owner, simpleEntry(f, 5, { periodId: october, entryDate: '2026-10-20' })),
        'FINANCE_PERIOD_CLOSED'
      )
    })

    it('moves the lock only to the end of the last closed period', async () => {
      const change = (lockedThrough: Date | null) =>
        owner.financeSettings.update({
          where: { organizationId: orgB.id },
          data: { lockedThrough }
        })
      await refused(change(day('2026-11-30')), 'FINANCE_PERIOD_CLOSED')
      await refused(change(day('2026-01-31')), 'FINANCE_PERIOD_CLOSED')
    })

    it('keeps its place in the calendar, and a closed one is frozen until it is reopened with who, when and why', async () => {
      const closed = await createPeriod(owner, orgA.id, 2026, 6, PeriodStatus.CLOSED)
      const open = await createPeriod(owner, orgA.id, 2026, 5)
      await refused(
        owner.fiscalPeriod.update({
          where: { id: open },
          data: { year: 2027, startsOn: day('2027-05-01'), endsOn: day('2027-05-31') }
        }),
        'a period keeps its place in the calendar'
      )
      await refused(
        owner.fiscalPeriod.update({ where: { id: closed }, data: { closingHash: 'f'.repeat(64) } }),
        'a closed period is frozen'
      )
      await refused(
        owner.fiscalPeriod.update({ where: { id: closed }, data: { closedBy: 'someone-else' } }),
        'a closed period is frozen'
      )
      await refused(
        owner.fiscalPeriod.delete({ where: { id: closed } }),
        'a closed period is not deleted'
      )
      await refused(
        owner.fiscalPeriod.update({ where: { id: closed }, data: { status: PeriodStatus.OPEN } }),
        'says who, when and why'
      )
      await refused(
        owner.fiscalPeriod.update({
          where: { id: closed },
          data: {
            status: PeriodStatus.OPEN,
            reopenedAt: new Date(),
            reopenedBy: 'u',
            reopenReason: '  '
          }
        }),
        'says who, when and why'
      )
      await expect(
        owner.fiscalPeriod.update({
          where: { id: closed },
          data: {
            status: PeriodStatus.OPEN,
            reopenedAt: new Date(),
            reopenedBy: 'u',
            reopenReason: 'a missing invoice'
          }
        })
      ).resolves.toMatchObject({ status: PeriodStatus.OPEN })
      // Closed again and reopened again: the record of the reopen of a closed period is frozen, and a reopen keeps the record of the close
      await owner.fiscalPeriod.update({
        where: { id: closed },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: 'u' }
      })
      await owner.fiscalPeriod.update({
        where: { id: closed },
        data: {
          status: PeriodStatus.OPEN,
          reopenedAt: new Date(),
          reopenedBy: 'u2',
          reopenReason: 'again'
        }
      })
      await owner.fiscalPeriod.update({
        where: { id: closed },
        data: { status: PeriodStatus.CLOSED, closedAt: new Date(), closedBy: 'u' }
      })
      await refused(
        owner.fiscalPeriod.update({ where: { id: closed }, data: { reopenReason: 'rewritten' } }),
        'a closed period is frozen'
      )
      await refused(
        owner.fiscalPeriod.update({
          where: { id: closed },
          data: {
            status: PeriodStatus.OPEN,
            reopenedAt: new Date(),
            reopenedBy: 'u3',
            reopenReason: 'x',
            closedBy: null
          }
        }),
        'the record of the close is kept'
      )
      // A reopen is a new one: the record of the earlier reopen does not stand for the next
      await refused(
        owner.fiscalPeriod.update({ where: { id: closed }, data: { status: PeriodStatus.OPEN } }),
        'says who, when and why'
      )
      // An open period keeps the record of its close and of its reopen as it is
      const reopened = await createPeriod(owner, orgA.id, 2026, 4, PeriodStatus.CLOSED)
      await owner.fiscalPeriod.update({
        where: { id: reopened },
        data: {
          status: PeriodStatus.OPEN,
          reopenedAt: new Date(),
          reopenedBy: 'u',
          reopenReason: 'why'
        }
      })
      await refused(
        owner.fiscalPeriod.update({ where: { id: reopened }, data: { closedBy: 'forged' } }),
        'the record of the close and of the reopen is kept'
      )
      await refused(
        owner.fiscalPeriod.update({ where: { id: reopened }, data: { reopenReason: 'forged' } }),
        'the record of the close and of the reopen is kept'
      )
      // An open period with nothing in it may be deleted
      await expect(owner.fiscalPeriod.delete({ where: { id: open } })).resolves.toBeDefined()
    })

    it('must contain the date of the entry', async () => {
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { entryDate: '2026-12-01' })),
        /not in the period/
      )
    })

    it('must be of the organization of the entry', async () => {
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { periodId: b.periodId })),
        /not in the period it names|journal_entries_organization_id_period_id_fkey/
      )
    })

    it('does not take a date before the day the books start', async () => {
      // An organization with no closed period: a closed one locks every day up to its end, which would answer first
      const org = await owner.organization.create({
        data: { name: `${prefix}-st`, slug: `${prefix}-st` }
      })
      const f = await createFinanceFixture(owner, org.id)
      const early = await createPeriod(owner, org.id, 2025, 12)
      await refused(
        postTestEntry(owner, simpleEntry(f, 5, { periodId: early, entryDate: '2025-12-15' })),
        'FINANCE_BEFORE_START_DATE'
      )
    })

    it('has the bounds of a calendar month, one period per month and a close that says who closed it', async () => {
      await refused(
        owner.fiscalPeriod.create({
          data: {
            organizationId: orgA.id,
            year: 2026,
            month: 3,
            startsOn: day('2026-03-01'),
            endsOn: day('2026-03-30')
          }
        }),
        'chk_fiscal_periods_bounds'
      )
      await refused(
        createPeriod(owner, orgA.id, 2026, 11),
        /Unique constraint|organization_id_year_month/
      )
      await refused(
        owner.fiscalPeriod.create({
          data: {
            organizationId: orgA.id,
            year: 2027,
            month: 2,
            startsOn: day('2027-02-01'),
            endsOn: day('2027-02-28'),
            status: PeriodStatus.CLOSED
          }
        }),
        'chk_fiscal_periods_closed'
      )
    })
  })

  describe('the journal is append-only', () => {
    it('refuses to change or remove an entry or a line, even for the owner of the database', async () => {
      const entry = await postTestEntry(owner, simpleEntry(a, 321))
      const [line] = entry.lines
      if (line === undefined) throw new Error('the entry has no lines')
      await refused(
        owner.journalEntry.update({ where: { id: entry.id }, data: { memo: 'edited' } }),
        'FINANCE_LEDGER_IMMUTABLE'
      )
      await refused(
        owner.journalEntry.delete({ where: { id: entry.id } }),
        'FINANCE_LEDGER_IMMUTABLE'
      )
      await refused(
        owner.journalLine.update({ where: { id: line.id }, data: { debitCents: 1 } }),
        'FINANCE_LEDGER_IMMUTABLE'
      )
      await refused(
        owner.journalLine.delete({ where: { id: line.id } }),
        'FINANCE_LEDGER_IMMUTABLE'
      )
      await refused(
        owner.$executeRaw`UPDATE journal_lines SET account_id = ${a.accounts.revenue} WHERE entry_id = ${entry.id}`,
        'FINANCE_LEDGER_IMMUTABLE'
      )
      await refused(
        owner.$executeRaw`DELETE FROM journal_entries WHERE organization_id = ${orgA.id}`,
        'FINANCE_LEDGER_IMMUTABLE'
      )
      // The decisions of the reconciliation name journal lines, so the table is truncated with them (alone it is refused for the key)
      await refused(
        owner.$executeRawUnsafe('TRUNCATE journal_lines, reconciliation_matches'),
        'FINANCE_LEDGER_IMMUTABLE'
      )
      await refused(
        owner.$executeRawUnsafe('TRUNCATE journal_entries CASCADE'),
        'FINANCE_LEDGER_IMMUTABLE'
      )
      expect(await owner.journalEntry.findUnique({ where: { id: entry.id } })).toMatchObject({
        memo: null,
        hash: entry.hash
      })
    })

    it('gives no role of the application the privilege to change, remove or empty it', async () => {
      const has = async (role: string, table: string, privilege: string): Promise<boolean> => {
        const rows = await owner.$queryRaw<{ allowed: boolean }[]>`
          SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS allowed`
        return rows[0]?.allowed === true
      }
      for (const role of ['platform_app', 'platform_worker']) {
        for (const table of ['journal_entries', 'journal_lines']) {
          for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
            expect({ role, table, privilege, allowed: await has(role, table, privilege) }).toEqual({
              role,
              table,
              privilege,
              allowed: false
            })
          }
          for (const privilege of ['SELECT', 'INSERT']) {
            expect(await has(role, table, privilege)).toBe(true)
          }
        }
        // The other tables of the books are not empty-able either (the roles never held TRUNCATE on any of them)
        for (const table of [
          'finance_settings',
          'ledger_accounts',
          'fiscal_periods',
          'account_period_balances'
        ]) {
          expect(await has(role, table, 'TRUNCATE')).toBe(false)
          expect(await has(role, table, 'SELECT')).toBe(true)
        }
      }
    })

    it('lets the roles of the application add a transaction by hand and point it at its voiding entry, and change or remove nothing else', async () => {
      const allowed = async (role: string, privilege: string): Promise<boolean> =>
        (
          await owner.$queryRaw<{ allowed: boolean }[]>`
            SELECT has_table_privilege(${role}, 'finance_transactions', ${privilege}) AS allowed`
        )[0]?.allowed === true
      const column = async (role: string, name: string): Promise<boolean> =>
        (
          await owner.$queryRaw<{ allowed: boolean }[]>`
            SELECT has_column_privilege(${role}, 'finance_transactions', ${name}, 'UPDATE') AS allowed`
        )[0]?.allowed === true
      for (const role of ['platform_app', 'platform_worker']) {
        expect(await allowed(role, 'SELECT')).toBe(true)
        expect(await allowed(role, 'INSERT')).toBe(true)
        for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          expect({ role, privilege, allowed: await allowed(role, privilege) }).toEqual({
            role,
            privilege,
            allowed: false
          })
        }
        // A privilege on a column only: the table-level UPDATE above is false
        expect(await column(role, 'voided_by_entry_id')).toBe(true)
        for (const name of ['amount_cents', 'memo', 'entry_id', 'kind', 'from_account_id']) {
          expect({ role, name, allowed: await column(role, name) }).toEqual({
            role,
            name,
            allowed: false
          })
        }
      }
    })
  })

  describe('the roles of the application', () => {
    // The design stands on privileges and on triggers that run as the owner of the function: this posts as the role of the api
    // and tries what it must not do, so a missing grant shows here and not in the second PR
    it('post an entry, move the head and the balances through the triggers, and can do nothing else to the books', async () => {
      const app = createOwnerClient(connectionUrls().app)
      try {
        const org = await owner.organization.create({
          data: { name: `${prefix}-app`, slug: `${prefix}-app` }
        })
        const f = await createFinanceFixture(owner, org.id)
        const entry = await postTestEntry(app, simpleEntry(f, 777))
        expect(entry.number).toBe(1n)
        expect(
          await owner.financeSettings.findUniqueOrThrow({ where: { organizationId: org.id } })
        ).toMatchObject({ nextEntryNumber: 2n, lastEntryHash: entry.hash })
        expect(
          await owner.accountPeriodBalance.findFirst({
            where: { organizationId: org.id, accountId: f.accounts.expense }
          })
        ).toMatchObject({ debitCents: 777n })
        // What it still may do: the settings it holds, and the lock after a close
        await app.financeSettings.update({
          where: { organizationId: org.id },
          data: { recognizeSaleOn: 'shipped' }
        })
        // What it may not
        await refused(
          app.journalEntry.update({ where: { id: entry.id }, data: { memo: 'x' } }),
          /permission denied/
        )
        await refused(
          app.journalLine.deleteMany({ where: { entryId: entry.id } }),
          /permission denied/
        )
        await refused(
          app.financeSettings.update({
            where: { organizationId: org.id },
            data: { nextEntryNumber: 99n }
          }),
          /permission denied/
        )
        await refused(
          app.financeSettings.delete({ where: { organizationId: org.id } }),
          /permission denied/
        )
        await refused(
          app.accountPeriodBalance.updateMany({
            where: { organizationId: org.id },
            data: { debitCents: 0n }
          }),
          /permission denied/
        )
        await refused(
          app.accountPeriodBalance.create({
            data: { organizationId: org.id, accountId: f.accounts.bank, periodId: f.periodId }
          }),
          /permission denied/
        )
      } finally {
        await app.$disconnect()
      }
    })
  })

  describe('the counter and the head of the chain', () => {
    it('are not updatable by the roles of the application, which hold the other settings columns', async () => {
      const canTable = async (role: string, privilege: string): Promise<boolean> => {
        const rows = await owner.$queryRaw<{ allowed: boolean }[]>`
          SELECT has_table_privilege(${role}, 'finance_settings', ${privilege}) AS allowed`
        return rows[0]?.allowed === true
      }
      const can = async (role: string, column: string): Promise<boolean> => {
        const rows = await owner.$queryRaw<{ allowed: boolean }[]>`
          SELECT has_column_privilege(${role}, 'finance_settings', ${column}, 'UPDATE') AS allowed`
        return rows[0]?.allowed === true
      }
      for (const role of ['platform_app', 'platform_worker']) {
        expect(await can(role, 'next_entry_number')).toBe(false)
        expect(await can(role, 'last_entry_hash')).toBe(false)
        // The row of the settings is never deleted: a new one would start the counter and the lock again
        expect(await canTable(role, 'DELETE')).toBe(false)
        for (const column of [
          'locked_through',
          'recognize_sale_on',
          'country_code',
          'rounding_account_id'
        ]) {
          expect(await can(role, column)).toBe(true)
        }
      }
    })
  })

  describe('the number and the chain', () => {
    it('refuse a number that skips, repeats or goes back', async () => {
      const head = await headOf(orgA.id)
      await refused(
        postTestEntry(
          owner,
          simpleEntry(a, 5, { override: { number: head.nextEntryNumber + 1n } })
        ),
        'FINANCE_ENTRY_NUMBER'
      )
      await refused(
        postTestEntry(
          owner,
          simpleEntry(a, 5, { override: { number: head.nextEntryNumber - 1n } })
        ),
        /FINANCE_ENTRY_NUMBER|chk_journal_entries_chain|organization_id_number/
      )
    })

    it('refuse an entry that does not point at the last one', async () => {
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { override: { prevHash: 'f'.repeat(64) } })),
        'FINANCE_ENTRY_CHAIN'
      )
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { override: { prevHash: null } })),
        /FINANCE_ENTRY_CHAIN|chk_journal_entries_chain/
      )
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { override: { hash: 'not-a-hash' } })),
        'chk_journal_entries_hash'
      )
    })

    it('refuse a direct change of the counter or of the head, by the application or anybody', async () => {
      const head = await headOf(orgA.id)
      await refused(
        owner.financeSettings.update({
          where: { organizationId: orgA.id },
          data: { nextEntryNumber: head.nextEntryNumber + 5n }
        }),
        'FINANCE_ENTRY_NUMBER'
      )
      await refused(
        owner.financeSettings.update({
          where: { organizationId: orgA.id },
          data: { lastEntryHash: 'a'.repeat(64) }
        }),
        'FINANCE_ENTRY_NUMBER'
      )
      // The rest of the settings are the owner's to change
      await owner.financeSettings.update({
        where: { organizationId: orgA.id },
        data: { recognizeSaleOn: 'shipped' }
      })
      await owner.financeSettings.update({
        where: { organizationId: orgA.id },
        data: { recognizeSaleOn: 'delivered' }
      })
    })

    it('stay gapless and chained under concurrent posts that take turns on the settings', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-c`, slug: `${prefix}-c` }
      })
      const c = await createFinanceFixture(owner, org.id)
      const posts = Array.from({ length: 12 }, (_, index) =>
        postTestEntry(
          owner,
          simpleEntry(c, 100 + index, { idempotencyKey: `${prefix}:race:${index}` })
        )
      )
      const settled = await Promise.allSettled(posts)
      expect(settled.filter(result => result.status === 'rejected')).toEqual([])

      const rows = await owner.journalEntry.findMany({
        where: { organizationId: org.id },
        orderBy: { number: 'asc' },
        include: { lines: { orderBy: { lineNo: 'asc' } } }
      })
      expect(rows.map(row => row.number)).toEqual(
        Array.from({ length: 12 }, (_, index) => BigInt(index + 1))
      )
      const chain: ChainEntry[] = rows.map(row => ({
        id: row.id,
        number: row.number,
        entryDate: row.entryDate.toISOString().slice(0, 10),
        periodId: row.periodId,
        totalCents: row.totalCents,
        currency: row.currency,
        type: row.type,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceDate: row.sourceDate === null ? null : row.sourceDate.toISOString().slice(0, 10),
        reversesEntryId: row.reversesEntryId,
        idempotencyKey: row.idempotencyKey,
        memo: row.memo,
        origin: row.origin,
        createdBy: row.createdBy,
        prevHash: row.prevHash,
        hash: row.hash,
        lines: row.lines
      }))
      expect(verifyChain(chain)).toBeNull()
      const head = await headOf(org.id)
      expect(head.nextEntryNumber).toBe(13n)
      expect(head.lastEntryHash).toBe(chain.at(-1)?.hash)
    })
  })

  describe('a reversal', () => {
    const reversalOf = (entryId: string, cents: number) => ({
      organizationId: orgA.id,
      periodId: a.periodId,
      type: JournalEntryType.REVERSAL,
      reversesEntryId: entryId,
      lines: [
        { accountId: a.accounts.expense, creditCents: cents },
        { accountId: a.accounts.cash, debitCents: cents }
      ]
    })

    it('is an entry of its own that points at the one it reverses, once', async () => {
      const original = await postTestEntry(owner, simpleEntry(a, 4000))
      const reversal = await postTestEntry(owner, reversalOf(original.id, 4000))
      expect(reversal.reversesEntryId).toBe(original.id)
      expect(reversal.number).toBeGreaterThan(original.number)
      // The original is not touched, and it cannot be reversed again
      await refused(postTestEntry(owner, reversalOf(original.id, 4000)), /reverses_entry_id/)
    })

    it('is a reversal if and only if it points at an entry, never at another organization', async () => {
      const original = await postTestEntry(owner, simpleEntry(a, 10))
      await refused(
        postTestEntry(owner, simpleEntry(a, 10, { reversesEntryId: original.id })),
        'chk_journal_entries_reversal'
      )
      await refused(
        postTestEntry(owner, { ...simpleEntry(a, 10), type: JournalEntryType.REVERSAL }),
        'chk_journal_entries_reversal'
      )
      const foreign = await postTestEntry(owner, simpleEntry(b, 10))
      await refused(
        postTestEntry(owner, reversalOf(foreign.id, 10)),
        /journal_entries_organization_id_reverses_entry_id_fkey/
      )
    })
  })

  describe('the chart of accounts', () => {
    const account = (organizationId: string, code: string, extra: Record<string, unknown> = {}) =>
      owner.ledgerAccount.create({
        data: {
          organizationId,
          code,
          name: `Cuenta ${code}`,
          type: AccountType.EXPENSE,
          normalSide: NormalSide.DEBIT,
          ...extra
        }
      })
    const asset = { type: AccountType.ASSET, normalSide: NormalSide.DEBIT }

    it('has a code that is one per organization whatever its case, and valid', async () => {
      await account(orgA.id, 'X100')
      await refused(account(orgA.id, 'x100'), /uq_ledger_accounts_code_lower/)
      await expect(account(orgB.id, 'X100')).resolves.toBeDefined()
      for (const code of ['', ' X1', 'X 1', 'X/1', 'x'.repeat(21)]) {
        await refused(account(orgA.id, code), 'chk_ledger_accounts_code')
      }
      await refused(account(orgA.id, 'X101', { name: ' padded' }), 'chk_ledger_accounts_name')
      await refused(account(orgA.id, 'X102', { name: '' }), 'chk_ledger_accounts_name')
    })

    it('has the normal side its type gives, and only the types and currency of the MVP', async () => {
      await refused(
        account(orgA.id, 'X110', { normalSide: NormalSide.CREDIT }),
        'chk_ledger_accounts_normal_side'
      )
      await refused(
        account(orgA.id, 'X111', { type: 'nonsense' }),
        /chk_ledger_accounts_(type|normal_side)/
      )
      await refused(account(orgA.id, 'X112', { currency: 'COP' }), 'chk_ledger_accounts_currency')
      await refused(
        account(orgA.id, 'X113', { storeId: storeA.id }),
        'chk_ledger_accounts_org_wide'
      )
    })

    it('is cash, a bank or a wallet only when it is an asset that takes entries', async () => {
      await expect(
        account(orgA.id, 'X120', { ...asset, cashKind: CashKind.WALLET })
      ).resolves.toBeDefined()
      await refused(
        account(orgA.id, 'X121', { cashKind: CashKind.CASH }),
        'chk_ledger_accounts_cash_kind'
      )
      await refused(
        account(orgA.id, 'X122', { ...asset, cashKind: CashKind.CASH, isPostable: false }),
        'chk_ledger_accounts_cash_kind'
      )
      await refused(
        account(orgA.id, 'X123', { ...asset, cashKind: 'vault' }),
        'chk_ledger_accounts_cash_kind'
      )
    })

    it('sits under a parent of its own organization, and not under itself', async () => {
      await refused(
        account(orgA.id, 'X130', { parentId: b.accounts.header }),
        /ledger_accounts_organization_id_parent_id_fkey/
      )
      await refused(
        owner.ledgerAccount.update({
          where: { id: a.accounts.header },
          data: { parentId: a.accounts.header }
        }),
        'chk_ledger_accounts_not_own_parent'
      )
    })

    it('keeps its type and stays an account that takes entries once it has any', async () => {
      const used = await account(orgA.id, 'X140')
      await postTestEntry(owner, {
        ...simpleEntry(a, 1),
        lines: [
          { accountId: used.id, debitCents: 1 },
          { accountId: a.accounts.cash, creditCents: 1 }
        ]
      })
      await refused(
        owner.ledgerAccount.update({
          where: { id: used.id },
          data: { type: AccountType.INCOME, normalSide: NormalSide.CREDIT }
        }),
        'FINANCE_ACCOUNT_TYPE_LOCKED'
      )
      await refused(
        owner.ledgerAccount.update({ where: { id: used.id }, data: { isPostable: false } }),
        'FINANCE_ACCOUNT_HAS_ENTRIES'
      )
      // Renaming and deactivating stay allowed
      await expect(
        owner.ledgerAccount.update({
          where: { id: used.id },
          data: { name: 'Renamed', active: false }
        })
      ).resolves.toMatchObject({ name: 'Renamed', active: false })
      // An account with entries is never deleted (the foreign key), and a system account is not either
      await refused(
        owner.ledgerAccount.delete({ where: { id: used.id } }),
        /foreign key|journal_lines/
      )
      const system = await account(orgA.id, 'X141', { isSystem: true })
      await refused(
        owner.ledgerAccount.delete({ where: { id: system.id } }),
        'a system account cannot be deleted'
      )
      await refused(
        owner.ledgerAccount.update({ where: { id: system.id }, data: { isSystem: false } }),
        'a system account stays a system account'
      )
      const plain = await account(orgA.id, 'X142')
      await expect(owner.ledgerAccount.delete({ where: { id: plain.id } })).resolves.toBeDefined()
    })

    it('cannot change organization', async () => {
      const mover = await account(orgA.id, 'X150')
      await refused(
        owner.$executeRaw`UPDATE ledger_accounts SET organization_id = ${orgB.id} WHERE id = ${mover.id}`,
        /organization|foreign key/
      )
    })
  })

  describe('the maps of the accounts', () => {
    it('map a role to an account of the same organization only, once per role', async () => {
      await owner.accountRoleMapping.create({
        data: { organizationId: orgA.id, role: 'cash_default', accountId: a.accounts.cash }
      })
      await refused(
        owner.accountRoleMapping.create({
          data: { organizationId: orgA.id, role: 'cash_default', accountId: a.accounts.bank }
        }),
        /Unique constraint|account_role_mappings_pkey/
      )
      await refused(
        owner.accountRoleMapping.create({
          data: { organizationId: orgA.id, role: 'bank_default', accountId: b.accounts.bank }
        }),
        /account_role_mappings_organization_id_account_id_fkey/
      )
    })

    it('send a payment method to one default account per organization, never cash on delivery', async () => {
      await owner.paymentMethodAccount.create({
        data: { organizationId: orgA.id, paymentMethod: 'CASH', accountId: a.accounts.cash }
      })
      await refused(
        owner.paymentMethodAccount.create({
          data: { organizationId: orgA.id, paymentMethod: 'CASH', accountId: a.accounts.bank }
        }),
        /uq_payment_method_accounts_default/
      )
      await refused(
        owner.paymentMethodAccount.create({
          data: {
            organizationId: orgA.id,
            paymentMethod: 'CASH_ON_DELIVERY',
            accountId: a.accounts.cash
          }
        }),
        'chk_payment_method_accounts_method'
      )
      await refused(
        owner.paymentMethodAccount.create({
          data: { organizationId: orgA.id, paymentMethod: 'CARD', accountId: b.accounts.bank }
        }),
        /payment_method_accounts_organization_id_account_id_fkey/
      )
      // A store of its own may have its own account for the method (Phase 2 reads it)
      await expect(
        owner.paymentMethodAccount.create({
          data: {
            organizationId: orgA.id,
            storeId: storeA.id,
            paymentMethod: 'CASH',
            accountId: a.accounts.bank
          }
        })
      ).resolves.toBeDefined()
      await refused(
        owner.paymentMethodAccount.create({
          data: {
            organizationId: orgA.id,
            storeId: storeB.id,
            paymentMethod: 'CARD',
            accountId: a.accounts.bank
          }
        }),
        /payment_method_accounts_organization_id_store_id_fkey/
      )
    })
  })

  describe('the balances by period', () => {
    const balance = (
      organizationId: string,
      accountId: string,
      periodId: string,
      storeId: string | null
    ) =>
      owner.accountPeriodBalance.findFirst({
        where: { organizationId, accountId, periodId, storeId }
      })

    it('follow the lines by trigger, by account, period and store, a missing store being one', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-bal`, slug: `${prefix}-bal` }
      })
      const store = await ensureStore(owner, org.id, `${prefix}-store-bal`)
      const f = await createFinanceFixture(owner, org.id)
      await postTestEntry(owner, simpleEntry(f, 1000))
      await postTestEntry(owner, simpleEntry(f, 250))
      await postTestEntry(owner, {
        ...simpleEntry(f),
        lines: [
          { accountId: f.accounts.expense, debitCents: 40, storeId: store.id },
          { accountId: f.accounts.cash, creditCents: 40 }
        ]
      })
      expect(await balance(org.id, f.accounts.expense, f.periodId, null)).toMatchObject({
        debitCents: 1250n,
        creditCents: 0n
      })
      expect(await balance(org.id, f.accounts.cash, f.periodId, null)).toMatchObject({
        debitCents: 0n,
        creditCents: 1290n
      })
      expect(await balance(org.id, f.accounts.expense, f.periodId, store.id)).toMatchObject({
        debitCents: 40n
      })
      // The books balance: what was debited in all accounts is what was credited
      const sums = await owner.accountPeriodBalance.aggregate({
        where: { organizationId: org.id },
        _sum: { debitCents: true, creditCents: true }
      })
      expect(sums._sum.debitCents).toBe(sums._sum.creditCents)
    })

    it('are the same as the sum of the lines, past 32 bits', async () => {
      const org = await owner.organization.create({
        data: { name: `${prefix}-big`, slug: `${prefix}-big` }
      })
      const f = await createFinanceFixture(owner, org.id)
      const limit = 2_000_000_000
      for (let index = 0; index < 3; index += 1) {
        await postTestEntry(owner, simpleEntry(f, limit))
      }
      expect(await balance(org.id, f.accounts.expense, f.periodId, null)).toMatchObject({
        debitCents: BigInt(limit) * 3n
      })
    })

    it('are one row per account, period and store, and of one organization (the owner cannot break it either)', async () => {
      const row = (extra: Record<string, unknown> = {}) =>
        owner.accountPeriodBalance.create({
          data: {
            organizationId: orgA.id,
            accountId: a.accounts.liability,
            periodId: a.periodId,
            ...extra
          }
        })
      await row()
      await refused(row(), /uq_account_period_balances_no_store/)
      await row({ storeId: storeA.id })
      await refused(row({ storeId: storeA.id }), /uq_account_period_balances_store/)
      await refused(
        row({ debitCents: -1n, accountId: a.accounts.revenue }),
        'chk_account_period_balances_sums'
      )
      await refused(
        owner.accountPeriodBalance.create({
          data: { organizationId: orgA.id, accountId: b.accounts.cash, periodId: a.periodId }
        }),
        /account_period_balances_organization_id_account_id_fkey/
      )
    })

    it('cannot be written by the roles of the application, which read them', async () => {
      const has = async (role: string, privilege: string): Promise<boolean> => {
        const rows = await owner.$queryRaw<{ allowed: boolean }[]>`
          SELECT has_table_privilege(${role}, 'account_period_balances', ${privilege}) AS allowed`
        return rows[0]?.allowed === true
      }
      for (const role of ['platform_app', 'platform_worker']) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          expect({ role, privilege, allowed: await has(role, privilege) }).toEqual({
            role,
            privilege,
            allowed: false
          })
        }
        expect(await has(role, 'SELECT')).toBe(true)
      }
    })
  })

  describe('the settings of an organization', () => {
    it('hold USD and a country of two letters, a known recognition, and one row per organization', async () => {
      const change = (data: Record<string, unknown>) =>
        owner.financeSettings.update({ where: { organizationId: orgA.id }, data })
      await refused(change({ baseCurrency: 'COP' }), 'chk_finance_settings_currency')
      await refused(change({ countryCode: 'sv' }), 'chk_finance_settings_country')
      await refused(change({ recognizeSaleOn: 'whenever' }), 'chk_finance_settings_recognize')
      await refused(
        owner.financeSettings.create({
          data: {
            organizationId: orgA.id,
            countryCode: 'SV',
            accountingStartDate: day('2026-01-01')
          }
        }),
        /Unique constraint|finance_settings_pkey/
      )
    })

    it('are needed before an entry: an organization never set up refuses one', async () => {
      const bare = await owner.organization.create({
        data: { name: `${prefix}-bare`, slug: `${prefix}-bare` }
      })
      const period = await createPeriod(owner, bare.id, 2026, 11)
      await refused(
        owner.$executeRaw`INSERT INTO journal_entries (id, organization_id, number, entry_date, period_id, type, idempotency_key, total_cents, origin, hash)
          VALUES (gen_random_uuid()::text, ${bare.id}, 1, '2026-11-10', ${period}, 'expense', 'k', 1, 'system', ${'a'.repeat(64)})`,
        'FINANCE_SETUP_REQUIRED'
      )
    })
  })

  describe('the CHECKs that list a set of values', () => {
    // The enum is the source of truth (finance-constants.ts) and the database holds the same list where a wrong value would
    // break the books: adding a value to one and not to the other fails here
    const listedIn = async (constraint: string): Promise<string[]> => {
      const rows = await owner.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${constraint}`
      const def = rows[0]?.def ?? ''
      // The first ARRAY[...] of the definition: 'a'::text, 'b'::text
      const array = /ARRAY\[([^\]]*)\]/.exec(def)?.[1] ?? ''
      return [...array.matchAll(/'([^']*)'/g)].map(match => match[1] ?? '').sort()
    }
    it.each([
      ['chk_ledger_accounts_type', AccountType],
      ['chk_fiscal_periods_status', PeriodStatus],
      ['chk_journal_entries_origin', EntryOrigin],
      ['chk_journal_entries_type', JournalEntryType],
      ['chk_journal_entries_source_type', FinanceSourceType],
      ['chk_account_role_mappings_role', AccountRole],
      ['chk_ledger_accounts_cash_kind', CashKind],
      ['chk_journal_lines_party', PartyType],
      ['chk_finance_settings_recognize', SaleRecognition],
      ['chk_finance_posting_failures_source_type', FinanceSourceType],
      ['chk_finance_chain_incidents_reason', ChainProblem],
      ['chk_reconciliation_status', ReconciliationMatchStatus],
      ['chk_bank_profiles_thousands', BankThousandsSeparators],
      ['chk_bank_profiles_encoding', BankStatementEncodings],
      ['chk_bank_profiles_date_format', RemittanceDateFormats]
    ])('hold exactly the values of the enum in %s', async (constraint, values) => {
      expect(await listedIn(constraint)).toEqual(Object.values(values).sort())
    })

    it('holds the rows a bank profile skips between 0 and 50, and none for a profile that does not say', async () => {
      const rows = await owner.$queryRaw<{ def: string; dflt: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def,
               (SELECT column_default FROM information_schema.columns
                 WHERE table_name = 'bank_import_profiles' AND column_name = 'skip_rows') AS dflt
          FROM pg_constraint c WHERE c.conname = 'chk_bank_profiles_skip_rows'`
      expect(rows[0]?.def).toContain('skip_rows >= 0')
      expect(rows[0]?.def).toContain(`skip_rows <= ${BankStatementLimits.SKIP_ROWS_MAX}`)
      expect(rows[0]?.dflt).toBe('0')
    })

    it('keeps the separators of a bank profile apart, except a comma that is both the delimiter and the thousands', async () => {
      const rows = await owner.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_bank_profiles_separators'`
      const def = rows[0]?.def ?? ''
      // Kept: the delimiter is not the decimal separator, and neither the comma nor the dot is both thousands and decimal
      expect(def).toContain('delimiter <> decimal_separator')
      expect(def).toContain(
        "thousands_separator = 'comma'::text) AND (decimal_separator = ','::text"
      )
      expect(def).toContain("thousands_separator = 'dot'::text) AND (decimal_separator = '.'::text")
      // Dropped: a bank that quotes 1,234.50 in a comma file
      expect(def).not.toContain("delimiter = ','::text")
    })
  })

  describe('the incidents of the chain', () => {
    const incident = (organizationId: string, reason = ChainProblem.HASH_MISMATCH) => ({
      organizationId,
      reason,
      entryNumber: '1',
      entriesChecked: 3,
      lastSeenAt: new Date()
    })

    it('keep one open incident for each organization, and as many closed ones as there were', async () => {
      const first = await owner.financeChainIncident.create({ data: incident(orgA.id) })
      await expect(owner.financeChainIncident.create({ data: incident(orgA.id) })).rejects.toThrow()
      // Another organization has its own
      await owner.financeChainIncident.create({ data: incident(orgB.id) })
      await owner.financeChainIncident.update({
        where: { id: first.id },
        data: { resolvedAt: new Date() }
      })
      await owner.financeChainIncident.create({ data: incident(orgA.id) })
      expect(await owner.financeChainIncident.count({ where: { organizationId: orgA.id } })).toBe(2)
    })

    it('refuse a reason that is not a code of the check', async () => {
      await expect(
        owner.$executeRaw`INSERT INTO finance_chain_incidents (id, organization_id, reason, entries_checked, last_seen_at)
          VALUES (${crypto.randomUUID()}, ${orgB.id}, 'because I said so', 1, now())`
      ).rejects.toThrow()
    })
  })

  describe('the permissions', () => {
    it('are held by the Admin preset and by no other', () => {
      const finance: string[] = Object.values(Permissions).filter(
        permission => permission.startsWith('finance:') || permission.startsWith('fiscal:')
      )
      expect(finance).toHaveLength(16)
      for (const [role, permissions] of Object.entries(RolePresets)) {
        const held = permissions.filter(permission => finance.includes(permission))
        expect([role, held.length]).toEqual([role, role === RoleNames.ADMIN ? finance.length : 0])
      }
    })
  })
})
