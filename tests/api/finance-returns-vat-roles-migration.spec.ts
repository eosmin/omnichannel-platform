import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import pg from 'pg'

import { connectionUrls } from '@platform/core/database-testing'

const DATABASE = join(__dirname, '../../libs/core/database')
const MIGRATION = '20270217100000_finance_returns_vat_roles'

const migrationSql = readFileSync(
  join(DATABASE, 'prisma/migrations', MIGRATION, 'migration.sql'),
  'utf8'
)
// The script has its own BEGIN and COMMIT: the case wraps it in the transaction it throws away
const rollbackSql = readFileSync(join(DATABASE, 'rollbacks', `${MIGRATION}.rollback.sql`), 'utf8')
  .split('\n')
  .filter(line => !/^\s*(BEGIN|COMMIT);\s*$/i.test(line))
  .join('\n')

const ROLES = {
  vat_pending_document: '1402',
  income_tax_prepayment: '1405',
  vat_card_advance: '1406',
  accrued_commissions_undocumented: '2103',
  vat_non_recoverable: '6113'
} as const

// Organizations written with the foreign keys off for the transaction (the owner), never committed. The headers a chart needs for the new
// accounts: 14 (assets), 21 (liabilities) and 6 (expenses); `without` leaves one out, `taken` gives a code to an account of the owner.
async function chart(
  client: pg.Client,
  org: string,
  options: { without?: string; taken?: Record<string, string>; setUp?: boolean } = {}
): Promise<void> {
  if (options.setUp !== false) {
    await client.query(
      `INSERT INTO finance_settings (organization_id, country_code, accounting_start_date, updated_at)
       VALUES ($1, 'SV', '2027-01-01', now())`,
      [org]
    )
  }
  const headers = [
    ['14', 'Impuestos por recuperar', 'asset', 'debit'],
    ['21', 'Cuentas por pagar', 'liability', 'credit'],
    ['6', 'Gastos', 'expense', 'debit']
  ].filter(([code]) => code !== options.without)
  for (const [code, name, type, side] of headers) {
    await client.query(
      `INSERT INTO ledger_accounts (id, organization_id, code, name, type, normal_side, is_postable, is_system, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, true, now())`,
      [`${org}-h-${code}`, org, code, name, type, side]
    )
  }
  for (const [code, name] of Object.entries(options.taken ?? {})) {
    await client.query(
      `INSERT INTO ledger_accounts (id, organization_id, code, name, type, normal_side, is_postable, is_system, updated_at)
       VALUES ($1, $2, $3, $4, 'asset', 'debit', true, false, now())`,
      [`${org}-own-${code}`, org, code, name]
    )
  }
}

describe('Migration of the roles of returns and VAT', () => {
  let client: pg.Client

  beforeAll(async () => {
    client = new pg.Client({ connectionString: connectionUrls().owner })
    await client.connect()
  })
  afterAll(async () => {
    await client.end()
  })

  const accountsOf = async (org: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await client.query(
          `SELECT code, name FROM ledger_accounts WHERE organization_id = $1 AND code IN ('1402','1405','1406','2103','6113') ORDER BY code`,
          [org]
        )
      ).rows.map((row: { code: string; name: string }) => [row.code, row.name])
    )
  const mappingsOf = async (org: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await client.query(
          `SELECT m.role, a.code FROM account_role_mappings m
           JOIN ledger_accounts a ON a.organization_id = m.organization_id AND a.id = m.account_id
           WHERE m.organization_id = $1 AND m.role = ANY($2)`,
          [org, Object.keys(ROLES)]
        )
      ).rows.map((row: { role: string; code: string }) => [row.role, row.code])
    )

  async function inTransaction(work: () => Promise<void>): Promise<void> {
    await client.query('BEGIN')
    try {
      await client.query('SET LOCAL session_replication_role = replica')
      await work()
    } finally {
      await client.query('ROLLBACK')
    }
  }

  it('adds the five accounts and mappings to the books that exist, marked by their id and not as system accounts, and a second run adds nothing', async () => {
    await inTransaction(async () => {
      await chart(client, 'fr-a')
      await client.query(migrationSql)
      expect(await mappingsOf('fr-a')).toEqual(ROLES)
      expect(Object.keys(await accountsOf('fr-a'))).toEqual([
        '1402',
        '1405',
        '1406',
        '2103',
        '6113'
      ])
      const rows = (
        await client.query<Record<string, unknown>>(
          `SELECT code, (id = md5(organization_id || ':finance_returns_vat:' || code)::uuid::text) AS marked, is_system, is_postable, type, normal_side,
                  (SELECT p.code FROM ledger_accounts p WHERE p.id = a.parent_id) AS parent
           FROM ledger_accounts a WHERE organization_id = 'fr-a' AND code IN ('1402','2103','6113') ORDER BY code`
        )
      ).rows
      expect(rows).toEqual([
        {
          code: '1402',
          marked: true,
          is_system: false,
          is_postable: true,
          type: 'asset',
          normal_side: 'debit',
          parent: '14'
        },
        {
          code: '2103',
          marked: true,
          is_system: false,
          is_postable: true,
          type: 'liability',
          normal_side: 'credit',
          parent: '21'
        },
        {
          code: '6113',
          marked: true,
          is_system: false,
          is_postable: true,
          type: 'expense',
          normal_side: 'debit',
          parent: '6'
        }
      ])
      const count = async (): Promise<number> =>
        (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ledger_accounts`))
          .rows[0]?.n ?? -1
      const before = await count()
      await client.query(migrationSql)
      expect(await count()).toBe(before)
      expect(await mappingsOf('fr-a')).toEqual(ROLES)
    })
  })

  it('leaves alone an organization whose chart already uses a code (any case): the account is not touched and its role stays unmapped', async () => {
    await inTransaction(async () => {
      await chart(client, 'fr-b', { taken: { '1402': 'Mi cuenta propia', '6113': 'Otra cosa' } })
      await client.query(migrationSql)
      const accounts = await accountsOf('fr-b')
      // What the owner had is as it was, with its own name and no mapping
      expect(accounts['1402']).toBe('Mi cuenta propia')
      expect(accounts['6113']).toBe('Otra cosa')
      const mapped = await mappingsOf('fr-b')
      expect(mapped).toEqual({
        income_tax_prepayment: '1405',
        vat_card_advance: '1406',
        accrued_commissions_undocumented: '2103'
      })
      expect(mapped).not.toHaveProperty('vat_pending_document')
      expect(mapped).not.toHaveProperty('vat_non_recoverable')
    })
  })

  it('skips an account whose header is gone, and an organization that never set up its books', async () => {
    await inTransaction(async () => {
      await chart(client, 'fr-c', { without: '21' })
      await chart(client, 'fr-d', { setUp: false })
      await client.query(migrationSql)
      const mapped = await mappingsOf('fr-c')
      expect(mapped).not.toHaveProperty('accrued_commissions_undocumented')
      expect(Object.keys(mapped)).toHaveLength(4)
      expect(await accountsOf('fr-d')).toEqual({})
      expect(await mappingsOf('fr-d')).toEqual({})
    })
  })

  it('rolls back only what it wrote, keeps an account with entries or in use, never an account of the owner, and a second run changes nothing', async () => {
    await inTransaction(async () => {
      await chart(client, 'fr-e', { taken: { '1402': 'Cuenta del dueño' } })
      await client.query(migrationSql)
      // Entries on 1405 (income_tax_prepayment) keep it; a payment method pointing at 1406 keeps it
      const idOf = async (code: string): Promise<string> =>
        (
          await client.query<{ id: string }>(
            `SELECT id FROM ledger_accounts WHERE organization_id = 'fr-e' AND code = $1`,
            [code]
          )
        ).rows[0]?.id ?? ''
      await client.query(
        `INSERT INTO journal_lines (id, entry_id, organization_id, account_id, debit_cents, credit_cents, line_no)
         VALUES ('fr-e-l1', 'fr-e-entry', 'fr-e', $1, 100, 0, 1)`,
        [await idOf('1405')]
      )
      await client.query(
        `INSERT INTO payment_method_accounts (id, organization_id, payment_method, account_id) VALUES ('fr-e-pm', 'fr-e', 'card', $1)`,
        [await idOf('1406')]
      )
      // From here the foreign keys and the guards of the chart apply to the rollback
      await client.query('SET LOCAL session_replication_role = origin')
      await client.query(rollbackSql)
      const after = await accountsOf('fr-e')
      expect(after).toEqual({
        '1402': 'Cuenta del dueño',
        '1405': 'Pago a cuenta de renta',
        '1406': 'Anticipo de IVA 2 % de tarjetas'
      })
      expect(await mappingsOf('fr-e')).toEqual({
        income_tax_prepayment: '1405',
        vat_card_advance: '1406'
      })
      await client.query(rollbackSql)
      expect(await accountsOf('fr-e')).toEqual(after)
    })
  })

  it('never takes away the mapping of another role that someone pointed at one of its accounts: the account stays and so does the mapping', async () => {
    await inTransaction(async () => {
      await chart(client, 'fr-f')
      await client.query(migrationSql)
      const row = await client.query<{ id: string }>(
        `SELECT id FROM ledger_accounts WHERE organization_id = 'fr-f' AND code = '1405'`
      )
      await client.query(
        `INSERT INTO account_role_mappings (organization_id, role, account_id) VALUES ('fr-f', 'rounding', $1)`,
        [row.rows[0]?.id ?? '']
      )
      await client.query('SET LOCAL session_replication_role = origin')
      await client.query(rollbackSql)
      const mapped = await client.query<{ role: string }>(
        `SELECT role FROM account_role_mappings WHERE organization_id = 'fr-f' AND account_id = $1 ORDER BY role`,
        [row.rows[0]?.id ?? '']
      )
      // The rounding is still on it, and the role of the migration too: the account was kept as a whole
      expect(mapped.rows.map(found => found.role)).toEqual(['income_tax_prepayment', 'rounding'])
      expect(Object.keys(await accountsOf('fr-f'))).toEqual(['1405'])
    })
  })
})
