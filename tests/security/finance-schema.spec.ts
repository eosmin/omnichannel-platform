import { Permissions, RoleNames, RolePresets } from '@platform/core/auth'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  AccountType,
  CashKind,
  EntryOrigin,
  FinanceSourceType,
  JournalEntryType,
  NormalSide,
  PeriodStatus
} from '@platform/core/domain'
import { type ChainEntry, verifyChain } from '@platform/core/finance'

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
      const early = await createPeriod(owner, orgA.id, 2025, 12)
      await refused(
        postTestEntry(owner, simpleEntry(a, 5, { periodId: early, entryDate: '2025-12-15' })),
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
      await refused(owner.$executeRawUnsafe('TRUNCATE journal_lines'), 'FINANCE_LEDGER_IMMUTABLE')
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
  })

  describe('the counter and the head of the chain', () => {
    it('are not updatable by the roles of the application, which hold the other settings columns', async () => {
      const can = async (role: string, column: string): Promise<boolean> => {
        const rows = await owner.$queryRaw<{ allowed: boolean }[]>`
          SELECT has_column_privilege(${role}, 'finance_settings', ${column}, 'UPDATE') AS allowed`
        return rows[0]?.allowed === true
      }
      for (const role of ['platform_app', 'platform_worker']) {
        expect(await can(role, 'next_entry_number')).toBe(false)
        expect(await can(role, 'last_entry_hash')).toBe(false)
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
        'FINANCE_ACCOUNT_HAS_ENTRIES'
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
    it('are one row per account, period and store, a missing store being one, and of one organization', async () => {
      const row = (extra: Record<string, unknown> = {}) =>
        owner.accountPeriodBalance.create({
          data: {
            organizationId: orgA.id,
            accountId: a.accounts.cash,
            periodId: a.periodId,
            ...extra
          }
        })
      await row()
      await refused(row(), /uq_account_period_balances_no_store/)
      await row({ storeId: storeA.id })
      await refused(row({ storeId: storeA.id }), /uq_account_period_balances_store/)
      await refused(
        row({ debitCents: -1n, accountId: a.accounts.bank }),
        'chk_account_period_balances_sums'
      )
      await refused(
        owner.accountPeriodBalance.create({
          data: { organizationId: orgA.id, accountId: b.accounts.cash, periodId: a.periodId }
        }),
        /account_period_balances_organization_id_account_id_fkey/
      )
    })

    it('keep sums past 32 bits', async () => {
      const big = 9_000_000_000n
      const row = await owner.accountPeriodBalance.create({
        data: {
          organizationId: orgA.id,
          accountId: a.accounts.liability,
          periodId: a.periodId,
          debitCents: big,
          creditCents: big
        }
      })
      expect(row.debitCents).toBe(big)
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
      ['chk_account_role_mappings_role', AccountRole]
    ])('hold exactly the values of the enum in %s', async (constraint, values) => {
      expect(await listedIn(constraint)).toEqual(Object.values(values).sort())
    })
  })

  describe('the permissions', () => {
    it('are held by the Admin preset and by no other', () => {
      const finance: string[] = Object.values(Permissions).filter(
        permission => permission.startsWith('finance:') || permission.startsWith('fiscal:')
      )
      expect(finance).toHaveLength(13)
      for (const [role, permissions] of Object.entries(RolePresets)) {
        const held = permissions.filter(permission => finance.includes(permission))
        expect([role, held.length]).toEqual([role, role === RoleNames.ADMIN ? finance.length : 0])
      }
    })
  })
})
