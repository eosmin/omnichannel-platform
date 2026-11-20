import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'

import { coveredTables } from '../../scripts/lib/rls'
import { RLS_EXEMPTIONS } from '../../scripts/rls-exceptions'
import {
  createInventoryLevel,
  createOrder,
  createOrderMessageTemplate,
  createProductVariant,
  createShipment,
  createTransfer
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// Row-Level Security, phase 3: orders, inventory, shipping, returns and remittances (TDD_01 section 3.2, layer 3). The policies are
// declared by 20270121300000_rls_phase3_orders_inventory_shipping and enforced by nobody yet, so each case turns enforcement on
// INSIDE A TRANSACTION of the owner (ALTER TABLE ... FORCE ROW LEVEL SECURITY), drops to platform_app with SET LOCAL ROLE and rolls
// everything back: no other suite sees the tables enforced, and the policies are the very ones the real tables have.
//
// The cases that matter most here: a query with no filter by store answers the rows of the context only; a row of another store
// cannot be read, changed, deleted or written; the sibling stores of an organization are opened together only when the operation
// asks (a transfer); and the delete of a store, which counts the rows it would cascade through, cannot be fooled into a zero.

const MIGRATIONS = resolve(__dirname, '../../libs/core/database/prisma/migrations')

const STORE_TABLES = [
  'orders',
  'products',
  'order_item_allocations',
  'order_message_templates',
  'order_message_dispatches',
  'order_returns',
  'order_return_lines',
  'return_reception_batches',
  'return_reception_items',
  'inventory_levels',
  'inventory_movements',
  'stock_count_lines',
  'stock_transfer_lines',
  'carrier_connections',
  'carrier_services',
  'carrier_status_mappings',
  'carrier_unmapped_statuses',
  'carrier_guide_movements',
  'carrier_guide_policies',
  'carrier_benefit_periods',
  'guide_sequences',
  'shipments',
  'shipment_events',
  'pickup_requests',
  'bulk_label_jobs',
  'cod_remittances',
  'cod_remittance_lines',
  'remittance_import_profiles'
]
const ORGANIZATION_TABLES = ['warehouses', 'stock_transfers', 'stock_counts']
const BOTH_TABLES = ['store_warehouses']
// No owner column: a row is seen through its parent
const PARENT_TABLES = ['order_items', 'product_variants']
const PHASE3_TABLES = [...STORE_TABLES, ...ORGANIZATION_TABLES, ...BOTH_TABLES, ...PARENT_TABLES]

interface Context {
  stores?: string[]
  organizations?: string[]
}

describe('row-level security, phase 3 (orders, inventory, shipping)', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  let owner: OwnerClient
  let app: Awaited<ReturnType<typeof createTestApp>>
  let ctx: TestContext
  let raw: pg.Client
  const seen: {
    orderA: string
    orderB: string
    transferA: string
    transferA2: string
    templateA: string
  } = {
    templateA: '',
    orderA: '',
    orderB: '',
    transferA: '',
    transferA2: ''
  }

  // A transaction of the owner on which the 34 tables are enforced and the role is platform_app, with the context set the way the
  // tenant interceptor sets it. Always rolled back.
  async function underRls<T>(
    context: Context,
    work: (db: pg.Client) => Promise<T>,
    before?: (db: pg.Client) => Promise<void>
  ): Promise<T> {
    await raw.query('BEGIN')
    try {
      for (const table of PHASE3_TABLES) {
        await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
        await raw.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      }
      if (before !== undefined) await before(raw)
      await raw.query('SET LOCAL ROLE platform_app')
      await raw.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', $2, true)",
        [(context.stores ?? []).join(','), (context.organizations ?? []).join(',')]
      )
      return await work(raw)
    } finally {
      await raw.query('ROLLBACK')
    }
  }

  const ids = (rows: Array<{ id: string }>): string[] => rows.map(row => row.id).sort()

  // A failure inside a transaction aborts it: the case runs its own transaction and reads the code of the error
  async function failureCode(
    context: Context,
    statement: string,
    values: unknown[] = []
  ): Promise<string | undefined> {
    try {
      await underRls(context, db => db.query(statement, values))
      return undefined
    } catch (error) {
      return (error as { code?: string }).code
    }
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    raw = new pg.Client({ connectionString: urls.owner })
    await raw.connect()

    const orderA = await createOrder(owner, { storeId: ctx.storeA.id })
    const orderB = await createOrder(owner, { storeId: ctx.storeB.id })
    seen.templateA = (await createOrderMessageTemplate(owner, { storeId: ctx.storeA.id })).id
    seen.orderA = orderA.id
    seen.orderB = orderB.id
    await createProductVariant(owner, { productId: orderA.productId })
    await createProductVariant(owner, { productId: orderB.productId })
    await createInventoryLevel(owner, {
      storeId: ctx.storeA.id,
      productId: orderA.productId,
      warehouseId: ctx.warehouseA.id,
      onHand: 5
    })
    await createInventoryLevel(owner, {
      storeId: ctx.storeB.id,
      productId: orderB.productId,
      warehouseId: ctx.warehouseB.id,
      onHand: 5
    })
    await createShipment(owner, { storeId: ctx.storeA.id })
    await createShipment(owner, { storeId: ctx.storeB.id })
    // One transfer of organization A with a line of store A and another of the sibling store A2
    seen.transferA = (
      await createTransfer(owner, { organizationId: ctx.orgA.id, storeId: ctx.storeA.id })
    ).id
    seen.transferA2 = (
      await createTransfer(owner, { organizationId: ctx.orgA.id, storeId: ctx.storeA2.id })
    ).id
  })

  afterAll(async () => {
    await raw.end().catch(() => undefined)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const A = (): Context => ({ stores: [ctx.storeA.id], organizations: [ctx.orgA.id] })

  it('declares a policy on each of the 34 tables and none of them is still listed as pending', () => {
    const migrations = readdirSync(MIGRATIONS)
      .filter(name => statSync(`${MIGRATIONS}/${name}`).isDirectory())
      .map(name => ({ name, sql: readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8') }))
    const covered = coveredTables(migrations)
    expect(PHASE3_TABLES).toHaveLength(34)
    expect(PHASE3_TABLES.filter(table => !covered.has(table))).toEqual([])
    expect(PHASE3_TABLES.filter(table => RLS_EXEMPTIONS[table] !== undefined)).toEqual([])
  })

  it('gives every table its tenant policy for the application roles and its own policy for the owner', async () => {
    const { rows } = await raw.query<{ polrelid: string; polname: string }>(
      `SELECT c.relname AS polrelid, p.polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = ANY ($1::text[])`,
      [PHASE3_TABLES]
    )
    const names = new Set(rows.map(row => row.polname))
    for (const table of PHASE3_TABLES) {
      expect(names).toContain(`${table}_tenant`)
      expect(names).toContain(`${table}_owner`)
    }
  })

  it('shows nothing to a transaction with no context, in any table that has rows', async () => {
    const counts = await underRls({}, async db => {
      const result: Record<string, number> = {}
      for (const table of PHASE3_TABLES) {
        result[table] =
          (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ??
          -1
      }
      return result
    })
    expect(Object.values(counts).every(n => n === 0)).toBe(true)
    // ... although the owner sees the rows (the cases below would pass for the wrong reason otherwise)
    for (const table of ['orders', 'order_items', 'product_variants', 'shipments', 'warehouses']) {
      const { rows } = await raw.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
      expect(rows[0]?.n).toBeGreaterThan(0)
    }
  })

  it('answers a query with no filter by store with the rows of the context only (orders, items, variants, stock, shipments)', async () => {
    const result = await underRls(A(), async db => ({
      orders: (await db.query<{ id: string }>('SELECT id FROM orders')).rows,
      items: (
        await db.query<{ id: string; order_id: string }>('SELECT id, order_id FROM order_items')
      ).rows,
      variants: (
        await db.query<{ id: string; product_id: string }>(
          'SELECT id, product_id FROM product_variants'
        )
      ).rows,
      levels: (
        await db.query<{ id: string; store_id: string }>(
          'SELECT id, store_id FROM inventory_levels'
        )
      ).rows,
      shipments: (
        await db.query<{ id: string; store_id: string }>('SELECT id, store_id FROM shipments')
      ).rows,
      connections: (
        await db.query<{ id: string; store_id: string }>(
          'SELECT id, store_id FROM carrier_connections'
        )
      ).rows
    }))
    expect(ids(result.orders)).toContain(seen.orderA)
    expect(ids(result.orders)).not.toContain(seen.orderB)
    const itemsOfA = await raw.query<{ id: string }>(
      'SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.store_id = $1',
      [ctx.storeA.id]
    )
    expect(itemsOfA.rows.length).toBeGreaterThan(0)
    expect(ids(result.items)).toEqual(ids(itemsOfA.rows))
    expect(result.variants.length).toBeGreaterThan(0)
    for (const rows of [result.levels, result.shipments, result.connections]) {
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(row => row.store_id === ctx.storeA.id)).toBe(true)
    }
    // The variants of store B's product are not there: its product is not seen
    const owned = await raw.query<{ id: string }>(
      'SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.store_id = $1',
      [ctx.storeA.id]
    )
    expect(ids(result.variants)).toEqual(ids(owned.rows))
  })

  it('finds no row of the other store by id, and changes or deletes none', async () => {
    const itemIdsOfB = (
      await raw.query<{ id: string }>('SELECT id FROM order_items WHERE order_id = $1', [
        seen.orderB
      ])
    ).rows.map(row => row.id)
    expect(itemIdsOfB.length).toBeGreaterThan(0)
    const outcome = await underRls(A(), async db => ({
      byId: (await db.query('SELECT id FROM orders WHERE id = $1', [seen.orderB])).rows,
      itemsById: (await db.query('SELECT id FROM order_items WHERE order_id = $1', [seen.orderB]))
        .rows,
      updated: (
        await db.query("UPDATE orders SET internal_notes = 'hacked' WHERE id = $1", [seen.orderB])
      ).rowCount,
      deleted: (await db.query('DELETE FROM orders WHERE id = $1', [seen.orderB])).rowCount,
      // By the ids of the items of that order (the owner knows them), never by a wide filter
      itemsDeleted: (
        await db.query('DELETE FROM order_items WHERE id = ANY ($1::text[])', [itemIdsOfB])
      ).rowCount
    }))
    expect(outcome.byId).toEqual([])
    expect(outcome.itemsById).toEqual([])
    expect(outcome.updated).toBe(0)
    expect(outcome.deleted).toBe(0)
    expect(outcome.itemsDeleted).toBe(0)
    const { rows } = await raw.query<{ internal_notes: string | null }>(
      'SELECT internal_notes FROM orders WHERE id = $1',
      [seen.orderB]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.internal_notes).not.toBe('hacked')
  })

  it('refuses to write a row of another store (42501), with the store in the body or with no context', async () => {
    const product = await owner.product.findFirstOrThrow({
      where: { storeId: ctx.storeB.id },
      select: { id: true }
    })
    const insert = `INSERT INTO inventory_levels (id, store_id, product_id, warehouse_id, on_hand, reserved) VALUES (gen_random_uuid()::text, $1, $2, $3, 1, 0)`
    const values = [ctx.storeB.id, product.id, ctx.warehouseB.id]
    // The stock levels have a trigger that checks the product belongs to the store: it may answer (23000) before the policy does
    expect(['42501', '23000']).toContain(await failureCode(A(), insert, values))
    expect(['42501', '23000']).toContain(await failureCode({}, insert, values))
    // A table with no trigger shows what the policy itself says
    const template = `INSERT INTO order_message_templates (id, store_id, kind, locale, body, updated_at)
      VALUES (gen_random_uuid()::text, $1, 'order_shipped', 'en', 'hello', now())`
    expect(await failureCode(A(), template, [ctx.storeB.id])).toBe('42501')
    expect(await failureCode({}, template, [ctx.storeA.id])).toBe('42501')
  })

  it('refuses to point a line of an order of this store at a product of another store (the foreign key does not see row security)', async () => {
    const foreign = await owner.product.findFirstOrThrow({
      where: { storeId: ctx.storeB.id },
      select: { id: true }
    })
    const code = await failureCode(
      A(),
      'UPDATE order_items SET product_id = $1 WHERE order_id = $2',
      [foreign.id, seen.orderA]
    )
    expect(code).toBe('42501')
  })

  it('does not let a row move to another store', async () => {
    const code = await failureCode(
      A(),
      'UPDATE order_message_templates SET store_id = $1 WHERE id = $2',
      [ctx.storeB.id, seen.templateA]
    )
    expect(code).toBe('42501')
    // Shipments have a trigger that may answer first
    const shipment = await failureCode(
      A(),
      'UPDATE shipments SET store_id = $1 WHERE store_id = $2',
      [ctx.storeB.id, ctx.storeA.id]
    )
    expect(['42501', '23000']).toContain(shipment)
  })

  it('sees the warehouses of the organization of the context and nobody else (scope organization)', async () => {
    const own = await underRls({ organizations: [ctx.orgA.id] }, db =>
      db.query<{ id: string; organization_id: string }>(
        'SELECT id, organization_id FROM warehouses'
      )
    )
    expect(own.rows.length).toBeGreaterThan(0)
    expect(own.rows.every(row => row.organization_id === ctx.orgA.id)).toBe(true)
    const storeOnly = await underRls({ stores: [ctx.storeA.id] }, db =>
      db.query('SELECT id FROM warehouses')
    )
    expect(storeOnly.rows).toEqual([])
    const crossed = await underRls({ organizations: [ctx.orgB.id] }, db =>
      db.query('SELECT id FROM stock_transfers WHERE organization_id = $1', [ctx.orgA.id])
    )
    expect(crossed.rows).toEqual([])
    expect(
      await failureCode(
        A(),
        "INSERT INTO warehouses (id, organization_id, name, code) VALUES (gen_random_uuid()::text, $1, 'x', 'XSS')",
        [ctx.orgB.id]
      )
    ).toBe('42501')
  })

  it('shows store_warehouses through the store or through the organization of the context', async () => {
    const byStore = await underRls({ stores: [ctx.storeA.id] }, db =>
      db.query<{ store_id: string }>('SELECT store_id FROM store_warehouses')
    )
    expect(byStore.rows.length).toBeGreaterThan(0)
    expect(byStore.rows.every(row => row.store_id === ctx.storeA.id)).toBe(true)
    const byOrganization = await underRls({ organizations: [ctx.orgA.id] }, db =>
      db.query<{ store_id: string }>('SELECT DISTINCT store_id FROM store_warehouses')
    )
    expect(byOrganization.rows.map(row => row.store_id).sort()).toEqual(
      [ctx.storeA.id, ctx.storeA2.id].sort()
    )
    const other = await underRls({ stores: [ctx.storeB.id] }, db =>
      db.query<{ store_id: string }>('SELECT store_id FROM store_warehouses WHERE store_id = $1', [
        ctx.storeA.id
      ])
    )
    expect(other.rows).toEqual([])
  })

  it('shows the lines of a transfer of sibling stores only to a context that opens every store of its lines', async () => {
    const lines = (context: Context): Promise<string[]> =>
      underRls(context, async db =>
        (
          await db.query<{ store_id: string }>(
            'SELECT store_id FROM stock_transfer_lines WHERE transfer_id = ANY ($1::text[])',
            [[seen.transferA, seen.transferA2]]
          )
        ).rows
          .map(row => row.store_id)
          .sort()
      )
    expect(await lines({ stores: [ctx.storeA.id], organizations: [ctx.orgA.id] })).toEqual([
      ctx.storeA.id
    ])
    expect(
      await lines({ stores: [ctx.storeA.id, ctx.storeA2.id], organizations: [ctx.orgA.id] })
    ).toEqual([ctx.storeA.id, ctx.storeA2.id].sort())
    expect(await lines({ stores: [ctx.storeB.id], organizations: [ctx.orgB.id] })).toEqual([])
  })

  it('lets INSERT ... ON CONFLICT of the stock levels work inside the context and fail outside it', async () => {
    const level = await owner.inventoryLevel.findFirstOrThrow({
      where: { storeId: ctx.storeA.id },
      select: { storeId: true, productId: true, warehouseId: true }
    })
    const statement = `INSERT INTO inventory_levels (id, store_id, product_id, warehouse_id, on_hand, reserved, updated_at)
      VALUES (gen_random_uuid()::text, $1, $2, $3, 1, 0, now())
      ON CONFLICT (store_id, product_id, warehouse_id) WHERE variant_id IS NULL DO UPDATE SET on_hand = inventory_levels.on_hand + 1
      RETURNING on_hand`
    const values = [level.storeId, level.productId, level.warehouseId]
    const inside = await underRls(A(), db => db.query<{ on_hand: number }>(statement, values))
    expect(inside.rows[0]?.on_hand).toBe(6)
    // From the context of another store the statement is refused: the stock trigger (23000) may answer before the policy (42501)
    const outside = await failureCode(
      { stores: [ctx.storeB.id], organizations: [ctx.orgB.id] },
      statement,
      values
    )
    expect(['42501', '23000']).toContain(outside)
    // ... and with no context at all, nothing is written either
    expect(['42501', '23000']).toContain(await failureCode({}, statement, values))
    const after = await raw.query<{ on_hand: number }>(
      'SELECT on_hand FROM inventory_levels WHERE store_id = $1 AND product_id = $2 AND warehouse_id = $3 AND variant_id IS NULL',
      values
    )
    expect(after.rows[0]?.on_hand).toBe(5)
  })

  describe('rls_store_tables_with_rows (the delete of a store)', () => {
    const SKIP = [
      'store_settings',
      'retention_settings',
      'business_hours',
      'memberships',
      'invitations',
      'roles',
      'audit_logs'
    ]

    // The context of the delete of a store: the route runs with the organization of the request in it
    const CONTEXT_A = { organizations: [] as string[] }
    beforeAll(() => {
      CONTEXT_A.organizations = [ctx.orgA.id]
    })

    it('counts the rows of a store with the rights of the owner, whatever the context of the caller, and a count of the caller sees none', async () => {
      const truth = await raw.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM orders WHERE store_id = $1',
        [ctx.storeA.id]
      )
      const found = await underRls(CONTEXT_A, async db => ({
        naive: (
          await db.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM orders WHERE store_id = $1',
            [ctx.storeA.id]
          )
        ).rows[0]?.n,
        counted: (
          await db.query<{ table_name: string; row_count: number }>(
            'SELECT table_name, row_count FROM rls_store_tables_with_rows($1::text)',
            [ctx.storeA.id]
          )
        ).rows
      }))
      // The trap: with row security on, the count of the caller is zero
      expect(found.naive).toBe(0)
      const orders = found.counted.find(row => row.table_name === 'orders')
      expect(orders?.row_count).toBe(truth.rows[0]?.n)
      const names = found.counted.map(row => row.table_name)
      for (const table of [
        'orders',
        'products',
        'inventory_levels',
        'shipments',
        'carrier_connections'
      ]) {
        expect(names).toContain(table)
      }
      expect(names).not.toContain('store_settings')
      // Every table that holds a row of the store is named, no more and no fewer than the owner counts
      const owned: string[] = []
      for (const row of (
        await raw.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'store_id' AND table_name <> ALL ($1::text[])",
          [SKIP]
        )
      ).rows) {
        const n =
          (
            await raw.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM ${row.table_name} WHERE store_id = $1`,
              [ctx.storeA.id]
            )
          ).rows[0]?.n ?? 0
        if (n > 0) owned.push(row.table_name)
      }
      expect([...names].sort()).toEqual(owned.sort())
    })

    it('answers no table for a store with no data, so its delete goes through, and the rows of the other stores stay', async () => {
      const empty = await ensureStore(owner, ctx.orgA.id, `${prefix}-empty`)
      const before = await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM orders')
      const result = await underRls(
        { stores: [empty.id], organizations: [ctx.orgA.id] },
        async db => {
          const tables = (
            await db.query('SELECT table_name FROM rls_store_tables_with_rows($1::text)', [
              empty.id
            ])
          ).rows
          const deleted = (
            await db.query('DELETE FROM stores WHERE id = $1 AND organization_id = $2', [
              empty.id,
              ctx.orgA.id
            ])
          ).rowCount
          return { tables, deleted }
        }
      )
      // The transaction was rolled back: the store is still there, and so are all the orders
      expect(result.tables).toEqual([])
      expect(result.deleted).toBe(1)
      const after = await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM orders')
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
      expect(await owner.store.count({ where: { id: empty.id } })).toBe(1)
    })

    it('fails closed (an error, no answer) when the function cannot see every row', async () => {
      await expect(
        underRls(
          CONTEXT_A,
          db => db.query('SELECT * FROM rls_store_tables_with_rows($1::text)', [ctx.storeA.id]),
          async db => {
            // The owner of the function is a role that owns no table and cannot bypass row security
            await db.query('GRANT CREATE ON SCHEMA public TO platform_app')
            await db.query('ALTER FUNCTION rls_store_tables_with_rows(text) OWNER TO platform_app')
          }
        )
      ).rejects.toThrow(/cannot see every row/)
    })

    it('fails closed when a table with row security has no policy that shows every row to its owner', async () => {
      await expect(
        underRls(
          CONTEXT_A,
          db => db.query('SELECT * FROM rls_store_tables_with_rows($1::text)', [ctx.storeA.id]),
          async db => {
            // The owner of the database is a superuser in the suites and skips row security: this is a role that owns every table
            // with a store_id (and the function) but has no policy of its own, as a table whose owner policy was forgotten
            await db.query('CREATE ROLE rls_probe_owner NOLOGIN')
            await db.query(
              `DO $$ DECLARE t text; BEGIN
                 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'store_id' AND NOT a.attisdropped
                   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') LOOP
                   EXECUTE format('ALTER TABLE public.%I OWNER TO rls_probe_owner', t);
                 END LOOP;
               END $$`
            )
            await db.query('GRANT CREATE ON SCHEMA public TO rls_probe_owner')
            await db.query(
              'ALTER FUNCTION rls_store_tables_with_rows(text) OWNER TO rls_probe_owner'
            )
          }
        )
      ).rejects.toThrow(/may hide rows from this role/)
    })

    it('takes no list of tables to leave out: the caller cannot hide a table that holds rows', async () => {
      // A second argument would be the way to make the delete of a store go through with its data: there is none (42883)
      await expect(
        underRls(CONTEXT_A, db =>
          db.query('SELECT * FROM rls_store_tables_with_rows($1::text, $2::text[])', [
            ctx.storeA.id,
            ['orders', 'products', 'inventory_levels']
          ])
        )
      ).rejects.toThrow(/does not exist/)
      const { rows } = await underRls(CONTEXT_A, db =>
        db.query<{ table_name: string }>(
          'SELECT table_name FROM rls_store_tables_with_rows($1::text)',
          [ctx.storeA.id]
        )
      )
      expect(rows.map(row => row.table_name)).toContain('orders')
    })

    it('refuses a call with no context at all, and answers nothing about a store of another organization (22023)', async () => {
      // The function runs as the owner and the store id is a parameter: with no check, any session of the application could ask
      // which tables hold rows of ANY store. Nothing in the context, or an organization that is not the owner of the store, is the
      // same error as a store that does not exist, so the answer does not tell which ids are real.
      const noContext = await underRls({}, db =>
        db.query('SELECT * FROM rls_store_tables_with_rows($1::text)', [ctx.storeA.id]).then(
          () => 'answered',
          (error: { code?: string }) => error.code
        )
      )
      expect(noContext).toBe('22023')
      const otherOrganization = await underRls({ organizations: [ctx.orgB.id] }, db =>
        db.query('SELECT * FROM rls_store_tables_with_rows($1::text)', [ctx.storeA.id]).then(
          () => 'answered',
          (error: { code?: string }) => error.code
        )
      )
      expect(otherOrganization).toBe('22023')
      const otherStore = await underRls({ stores: [ctx.storeB.id] }, db =>
        db.query('SELECT * FROM rls_store_tables_with_rows($1::text)', [ctx.storeA.id]).then(
          () => 'answered',
          (error: { code?: string }) => error.code
        )
      )
      expect(otherStore).toBe('22023')
      const unknown = await underRls(CONTEXT_A, db =>
        db.query("SELECT * FROM rls_store_tables_with_rows('no-such-store')").then(
          () => 'answered',
          (error: { code?: string }) => error.code
        )
      )
      expect(unknown).toBe('22023')
    })

    it('answers for the store of the context, with no organization in it', async () => {
      const { rows } = await underRls({ stores: [ctx.storeA.id] }, db =>
        db.query<{ table_name: string }>(
          'SELECT table_name FROM rls_store_tables_with_rows($1::text)',
          [ctx.storeA.id]
        )
      )
      expect(rows.map(row => row.table_name)).toContain('orders')
    })

    it('is executable by platform_app only, not by the worker nor PUBLIC', async () => {
      const { rows } = await raw.query<{ app: boolean; worker: boolean; pub: boolean }>(
        `SELECT has_function_privilege('platform_app', 'rls_store_tables_with_rows(text)', 'EXECUTE') AS app,
                has_function_privilege('platform_worker', 'rls_store_tables_with_rows(text)', 'EXECUTE') AS worker,
                has_function_privilege('public', 'rls_store_tables_with_rows(text)', 'EXECUTE') AS pub`
      )
      expect(rows[0]).toEqual({ app: true, worker: false, pub: false })
    })

    it('is not fooled by a temporary table of the caller with the name of a real one (the search path of a definer function)', async () => {
      const truth = await raw.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM orders WHERE store_id = $1',
        [ctx.storeA.id]
      )
      const counted = await underRls(CONTEXT_A, async db => {
        // The caller is platform_app, who may create temporary tables: this one shadows the real one for any code that does not pin
        // the schema
        await db.query('CREATE TEMP TABLE orders (store_id text)')
        await db.query('INSERT INTO pg_temp.orders SELECT $1 FROM generate_series(1, 1000)', [
          ctx.storeA.id
        ])
        return (
          await db.query<{ table_name: string; row_count: number }>(
            'SELECT table_name, row_count FROM rls_store_tables_with_rows($1::text)',
            [ctx.storeA.id]
          )
        ).rows
      })
      expect(counted.find(row => row.table_name === 'orders')?.row_count).toBe(truth.rows[0]?.n)
    })

    it('refuses an empty store id and cannot be called by PUBLIC', async () => {
      await expect(
        underRls(CONTEXT_A, db => db.query("SELECT * FROM rls_store_tables_with_rows('')"))
      ).rejects.toThrow(/store id is required/)
      const { rows } = await raw.query<{ acl: string | null }>(
        "SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'rls_store_tables_with_rows'"
      )
      expect(rows[0]?.acl).not.toMatch(/(^|,)=X/)
    })
  })
})
