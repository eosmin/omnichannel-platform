import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'

import { createFinanceFixture, postTestEntry, purgeFinance, simpleEntry } from '../builders/finance'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Row-Level Security, phase 4: the books of an ORGANIZATION (finance and fiscal; TDD_16 section 1). Three layers:
//  1. the catalog: each of the 29 tables has the policy that rls_apply_policy gives an organization table (predicate on
//     organization_id only, never on store_id; the owner policy that lets the SECURITY DEFINER triggers through);
//  2. the behavior, on a copy of the rows of the real tables that gets the very policy and is enforced alone (the real tables
//     are not enforced here: this file runs beside the other suites on one database);
//  3. the real tables, only when the whole database is enforced (TEST_RLS_ENFORCE=1, the CI job of phase 6): no context sees no
//     book, and an organization sees only its own.

const PHASE_4_TABLES = [
  'account_period_balances',
  'account_role_mappings',
  'ledger_accounts',
  'payment_method_accounts',
  'journal_entries',
  'journal_lines',
  'finance_settings',
  'finance_transactions',
  'finance_posting_failures',
  'finance_chain_incidents',
  'finance_book_layouts',
  'finance_book_snapshots',
  'tax_rates',
  'bank_import_profiles',
  'bank_statement_imports',
  'bank_statement_lines',
  'reconciliation_matches',
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'supplier_payments',
  'supplier_payment_returns',
  'fiscal_periods',
  'fiscal_issuers',
  'fiscal_sequences',
  'fiscal_documents',
  'fiscal_contingencies'
] as const

// The tables the fixtures fill for both organizations: the behavior cases run on them
const SEEDED = [
  'finance_settings',
  'fiscal_periods',
  'ledger_accounts',
  'tax_rates',
  'journal_entries',
  'journal_lines',
  'account_period_balances',
  'fiscal_issuers',
  'fiscal_sequences'
] as const

describe('row-level security, the books of an organization (phase 4)', () => {
  const run = randomUUID().replaceAll('-', '').slice(0, 8)
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const db: pg.Client = new pg.Client({ connectionString: urls.owner })
  const opened: pg.Client[] = []
  const copies = new Map<string, string>()
  let owner: OwnerClient
  let orgA = ''
  let orgB = ''
  // The CI job of phase 6 enforces the whole database: the real tables are then bound by their policies
  let enforced = false

  async function appClient(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: urls.app })
    await client.connect()
    opened.push(client)
    return client
  }

  // What the interceptor does: one transaction, the stores and the organization, transaction-local
  async function inContext<T>(
    client: pg.Client,
    context: { organizations?: string[]; stores?: string[] },
    work: () => Promise<T>
  ): Promise<T> {
    await client.query('BEGIN')
    try {
      await client.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
        [(context.stores ?? []).join(','), (context.organizations ?? []).join(',')]
      )
      const result = await work()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }

  async function failureCode(work: Promise<unknown>): Promise<string | undefined> {
    try {
      await work
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

  const count = async (
    client: pg.Client,
    table: string,
    where = 'true',
    params: unknown[] = []
  ): Promise<number> =>
    Number(
      (
        await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
          params
        )
      ).rows[0]?.n
    )

  // A row of a table as the document that populates a copy of it
  const rowOf = async (table: string, organizationId: string): Promise<Record<string, unknown>> => {
    const found = await db.query<{ doc: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS doc FROM ${copies.get(table) ?? table} t WHERE organization_id = $1 LIMIT 1`,
      [organizationId]
    )
    const doc = found.rows[0]?.doc
    if (!doc) throw new Error(`the fixtures wrote no row of ${table} for ${organizationId}`)
    return doc
  }

  beforeAll(async () => {
    await db.connect()
    enforced =
      (
        await db.query<{ on: boolean }>(
          "SELECT relforcerowsecurity AS on FROM pg_class WHERE oid = 'ledger_accounts'::regclass"
        )
      ).rows[0]?.on === true
    owner = ownerClient()
    orgA = (await owner.organization.create({ data: { name: `${prefix}-a`, slug: `${prefix}-a` } }))
      .id
    orgB = (await owner.organization.create({ data: { name: `${prefix}-b`, slug: `${prefix}-b` } }))
      .id
    for (const organizationId of [orgA, orgB]) {
      const books = await createFinanceFixture(owner, organizationId)
      await postTestEntry(owner, simpleEntry(books, 1500))
      await postTestEntry(
        owner,
        simpleEntry(books, 700, { idempotencyKey: `${prefix}-2-${organizationId}` })
      )
      await owner.fiscalIssuer.create({
        data: {
          organizationId,
          providerId: 'simulator',
          legalName: 'iso-issuer',
          taxId: 'ISO-TAX',
          address: { line1: 'x' },
          environment: 'sandbox'
        }
      })
      await owner.fiscalSequence.create({
        data: { organizationId, scopeKey: `${prefix}:serie`, scope: { serie: 'A' }, nextValue: 5 }
      })
    }
    // The copy of the rows of both organizations, with the policy of the real table and enforced alone
    let index = 0
    for (const table of PHASE_4_TABLES) {
      const copy = `rls_probe_f4_${run}_${index++}`
      copies.set(table, copy)
      if ((SEEDED as readonly string[]).includes(table)) {
        await db.query(
          `CREATE TABLE ${copy} AS SELECT * FROM ${table} WHERE organization_id = ANY($1::text[])`,
          [[orgA, orgB]]
        )
      } else {
        // The columns of the real table with no constraint, and two rows per organization that carry nothing else: the policy
        // only reads organization_id, and a table the fixtures never fill is still tested on the name of its column
        await db.query(`CREATE TABLE ${copy} AS SELECT * FROM ${table} WITH NO DATA`)
        await db.query(`INSERT INTO ${copy} (organization_id) VALUES ($1), ($1), ($2), ($2)`, [
          orgA,
          orgB
        ])
      }
      await db.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${copy} TO platform_app, platform_worker`
      )
      await db.query('SELECT rls_apply_policy($1::regclass, $2)', [copy, 'organization'])
    }
    // Two copies that keep the primary key of the real table, for the upserts of the books
    for (const table of ['fiscal_sequences', 'finance_settings']) {
      const copy = `rls_probe_f4_${run}_u_${table}`
      copies.set(`upsert:${table}`, copy)
      await db.query(`CREATE TABLE ${copy} (LIKE ${table} INCLUDING ALL)`)
      await db.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${copy} TO platform_app, platform_worker`
      )
      await db.query('SELECT rls_apply_policy($1::regclass, $2)', [copy, 'organization'])
    }
    await db.query('SELECT rls_set_enforcement(true, $1::text[])', [[...copies.values()]])
  })

  afterAll(async () => {
    for (const client of opened) await client.end().catch(() => undefined)
    for (const copy of copies.values()) await db.query(`DROP TABLE IF EXISTS ${copy}`)
    if (orgA && orgB) await purgeFinance(owner, [orgA, orgB])
    await cleanUp(owner, prefix)
    await owner.$disconnect()
    await db.end()
  })

  describe('the catalog', () => {
    it('gives each of the 29 tables the organization policy and the policy of its owner, and nothing on the store', async () => {
      const policies = await db.query<{
        tablename: string
        policyname: string
        cmd: string
        roles: string[]
        qual: string | null
        with_check: string | null
      }>(
        `SELECT tablename, policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [[...PHASE_4_TABLES]]
      )
      for (const table of PHASE_4_TABLES) {
        const tenant = policies.rows.find(row => row.policyname === `${table}_tenant`)
        expect({ table, found: tenant !== undefined }).toEqual({ table, found: true })
        expect(tenant?.cmd).toBe('ALL')
        expect([...(tenant?.roles ?? [])].sort()).toEqual(['platform_app', 'platform_worker'])
        for (const predicate of [tenant?.qual, tenant?.with_check]) {
          expect(predicate).toContain('organization_id = ANY')
          expect(predicate).toContain('app_organization_ids()')
          expect(predicate).not.toContain('store_id')
        }
        expect(policies.rows.some(row => row.policyname === `${table}_owner`)).toBe(true)
        // one tenant policy, never a split one: no table of the books has a row without an organization
        expect(
          policies.rows.filter(row => row.tablename === table && row.policyname.includes('_tenant'))
            .length
        ).toBe(1)
      }
    })

    it('leaves the real tables as the other suites expect them (the policies bind nobody until enforcement is turned on)', async () => {
      if (enforced) return
      const state = await db.query<{ relname: string; enabled: boolean; forced: boolean }>(
        `SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[])`,
        [[...PHASE_4_TABLES]]
      )
      expect(state.rows.filter(row => row.enabled || row.forced)).toEqual([])
    })

    it('keeps the privileges that the policy must never reopen: the balances are written by the trigger alone', async () => {
      for (const role of ['platform_app', 'platform_worker']) {
        const write = await db.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, 'account_period_balances', 'INSERT')
             OR has_table_privilege($1, 'account_period_balances', 'UPDATE')
             OR has_table_privilege($1, 'account_period_balances', 'DELETE') AS ok`,
          [role]
        )
        expect({ role, canWrite: write.rows[0]?.ok }).toEqual({ role, canWrite: false })
      }
    })
  })

  describe.each(PHASE_4_TABLES)('%s, on a copy that carries its policy', table => {
    const copy = (): string => copies.get(table) ?? ''

    it('has rows of both organizations to tell apart', async () => {
      expect(await count(db, copy(), 'organization_id = $1', [orgA])).toBeGreaterThan(0)
      expect(await count(db, copy(), 'organization_id = $1', [orgB])).toBeGreaterThan(0)
    })

    it('shows no row with no context, with a store context only, nor with the context of an organization that has no books', async () => {
      const client = await appClient()
      expect(await count(client, copy())).toBe(0)
      expect(await inContext(client, {}, () => count(client, copy()))).toBe(0)
      expect(await inContext(client, { stores: [orgA] }, () => count(client, copy()))).toBe(0)
      expect(
        await inContext(client, { organizations: [`none-${run}`] }, () => count(client, copy()))
      ).toBe(0)
    })

    it('answers a query with no filter with the rows of the organization of the context only', async () => {
      const client = await appClient()
      const ownRows = await count(db, copy(), 'organization_id = $1', [orgA])
      const seen = await inContext(client, { organizations: [orgA] }, () => count(client, copy()))
      expect(seen).toBe(ownRows)
      expect(
        await inContext(client, { organizations: [orgA] }, () =>
          count(client, copy(), 'organization_id = $1', [orgB])
        )
      ).toBe(0)
    })

    it('refuses to insert a row of another organization (42501), whatever its other columns say', async () => {
      const client = await appClient()
      const foreign = { ...(await rowOf(table, orgA)), organization_id: orgB }
      const code = await failureCode(
        inContext(client, { organizations: [orgA] }, () =>
          client.query(
            `INSERT INTO ${copy()} SELECT * FROM jsonb_populate_record(null::${copy()}, $1::jsonb)`,
            [JSON.stringify(foreign)]
          )
        )
      )
      expect(code).toBe('42501')
    })

    it('changes and deletes nothing of another organization, and refuses to move a row to it', async () => {
      const client = await appClient()
      const before = await count(db, copy(), 'organization_id = $1', [orgB])
      const updated = await inContext(client, { organizations: [orgA] }, () =>
        client.query(
          `UPDATE ${copy()} SET organization_id = organization_id WHERE organization_id = $1`,
          [orgB]
        )
      )
      const deleted = await inContext(client, { organizations: [orgA] }, () =>
        client.query(`DELETE FROM ${copy()} WHERE organization_id = $1`, [orgB])
      )
      expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0])
      expect(await count(db, copy(), 'organization_id = $1', [orgB])).toBe(before)
      const moved = await failureCode(
        inContext(client, { organizations: [orgA] }, () =>
          client.query(`UPDATE ${copy()} SET organization_id = $1 WHERE organization_id = $2`, [
            orgB,
            orgA
          ])
        )
      )
      expect(moved).toBe('42501')
    })

    it('writes the rows of its own organization, with a store in the context or not', async () => {
      const client = await appClient()
      const own = await rowOf(table, orgA)
      const written = await inContext(
        client,
        { organizations: [orgA], stores: [`store-${run}`] },
        () =>
          client.query(
            `INSERT INTO ${copy()} SELECT * FROM jsonb_populate_record(null::${copy()}, $1::jsonb)`,
            [JSON.stringify(own)]
          )
      )
      expect(written.rowCount).toBe(1)
      await db.query(
        `DELETE FROM ${copy()} WHERE ctid IN (SELECT max(ctid) FROM ${copy()} WHERE organization_id = $1)`,
        [orgA]
      )
    })
  })

  describe('a row at the level of the organization (no store)', () => {
    it('is seen and written through its organization: the store of a context is not its predicate', async () => {
      const copy = copies.get('ledger_accounts') ?? ''
      const client = await appClient()
      const unowned = await count(db, copy, 'organization_id = $1 AND store_id IS NULL', [orgA])
      expect(unowned).toBeGreaterThan(0)
      // seen with the organization alone, and with a store that is not the one of the row
      expect(
        await inContext(client, { organizations: [orgA] }, () =>
          count(client, copy, 'store_id IS NULL')
        )
      ).toBe(unowned)
      expect(
        await inContext(client, { organizations: [orgA], stores: [`other-${run}`] }, () =>
          count(client, copy, 'store_id IS NULL')
        )
      ).toBe(unowned)
      // never through the store alone
      expect(
        await inContext(client, { stores: [`other-${run}`] }, () =>
          count(client, copy, 'store_id IS NULL')
        )
      ).toBe(0)
    })
  })

  describe('the upserts of the books', () => {
    it('fiscal_sequences: INSERT ... ON CONFLICT DO UPDATE works for the own organization and fails closed for another', async () => {
      const copy = copies.get('upsert:fiscal_sequences') ?? ''
      const client = await appClient()
      const own = { ...(await rowOf('fiscal_sequences', orgA)), scope_key: `up-${run}` }
      const upsert = (row: Record<string, unknown>) =>
        client.query<{ next_value: number }>(
          `INSERT INTO ${copy} SELECT * FROM jsonb_populate_record(null::${copy}, $1::jsonb)
           ON CONFLICT (organization_id, scope_key) DO UPDATE SET next_value = ${copy}.next_value + 1
           RETURNING next_value`,
          [JSON.stringify(row)]
        )
      const first = await inContext(client, { organizations: [orgA] }, () => upsert(own))
      const second = await inContext(client, { organizations: [orgA] }, () => upsert(own))
      expect([first.rows[0]?.next_value, second.rows[0]?.next_value]).toEqual([5, 6])
      // a counter of another organization is neither read, nor taken over, nor created
      expect(
        await failureCode(inContext(client, { organizations: [orgB] }, () => upsert(own)))
      ).toBe('42501')
      expect(await inContext(client, { organizations: [orgB] }, () => count(client, copy))).toBe(0)
    })

    it('finance_settings: the row of the organization is read and updated by its own context only', async () => {
      const copy = copies.get('upsert:finance_settings') ?? ''
      const client = await appClient()
      const settings = await rowOf('finance_settings', orgA)
      await inContext(client, { organizations: [orgA] }, () =>
        client.query(
          `INSERT INTO ${copy} SELECT * FROM jsonb_populate_record(null::${copy}, $1::jsonb)`,
          [JSON.stringify(settings)]
        )
      )
      const own = await inContext(client, { organizations: [orgA] }, () =>
        client.query(`UPDATE ${copy} SET country_code = 'SV' WHERE organization_id = $1`, [orgA])
      )
      const other = await inContext(client, { organizations: [orgB] }, () =>
        client.query(`UPDATE ${copy} SET country_code = 'XX' WHERE organization_id = $1`, [orgA])
      )
      expect([own.rowCount, other.rowCount]).toEqual([1, 0])
      expect(await count(db, copy, "country_code = 'SV'")).toBe(1)
    })
  })

  // The real tables, when the CI job of phase 6 turned enforcement on for the whole database
  describe('the real tables, when the whole database is enforced', () => {
    it.each(SEEDED)(
      '%s: no context sees no row, and an organization sees only its own',
      async table => {
        if (!enforced) return
        const client = await appClient()
        expect(
          await count(client, table, 'organization_id = ANY($1::text[])', [[orgA, orgB]])
        ).toBe(0)
        const own = await count(db, table, 'organization_id = $1', [orgA])
        expect(
          await inContext(client, { organizations: [orgA] }, () =>
            count(client, table, 'organization_id = ANY($1::text[])', [[orgA, orgB]])
          )
        ).toBe(own)
        expect(
          await inContext(client, { organizations: [orgA] }, () =>
            count(client, table, 'organization_id = $1', [orgB])
          )
        ).toBe(0)
      }
    )

    it('refuses an entry of the ledger of another organization and keeps the append-only triggers of the own one', async () => {
      if (!enforced) return
      const client = await appClient()
      const code = await failureCode(
        inContext(client, { organizations: [orgA] }, () =>
          client.query(
            `INSERT INTO ledger_accounts (id, organization_id, code, name, type, normal_side, updated_at)
             VALUES ($1, $2, $3, 'x', 'asset', 'debit', now())`,
            [randomUUID(), orgB, `rls4-${run}`]
          )
        )
      )
      expect(code).toBe('42501')
      // the positive control: the same row for the own organization is valid and goes in, so the refusal above is the policy's
      const written = await inContext(client, { organizations: [orgA] }, () =>
        client.query(
          `INSERT INTO ledger_accounts (id, organization_id, code, name, type, normal_side, updated_at)
           VALUES ($1, $2, $3, 'x', 'asset', 'debit', now())`,
          [randomUUID(), orgA, `rls4-${run}`]
        )
      )
      expect(written.rowCount).toBe(1)
    })
  })
})
