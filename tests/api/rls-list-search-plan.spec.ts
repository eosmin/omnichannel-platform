import { randomUUID } from 'node:crypto'

import pg from 'pg'

import {
  connectionUrls,
  ensureStore,
  type OwnerClient,
  DatabaseRoles
} from '@platform/core/database-testing'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { retryOnDeadlock } from '../helpers/deadlock-retry'
import { PLAN_SPEC_TABLES, quietTables } from '../helpers/quiet-tables'

// The searches of the LISTS (the customers list and its export, the orders list and its export) are Prisma `contains` / `startsWith`
// filters, so they are LIKE / ILIKE statements on the same columns the search reads. The search of the inbox went through functions
// because, with row security on, the planner no longer pushed its text operators to the index (they are not leakproof). The question
// here is whether the same happens to the lists, and the answer that matters is not "do they use a trigram index" (with this volume
// they read the store index even with the policies off: the planner prefers the b-tree of the store for a LIKE '%text%' over a
// bitmap of the whole table) but "does turning the policies ON change HOW the list reads the table". If it does not, enforcement
// costs the lists nothing and they need no function; if it does, the plan of both is in the message of the failure.
//
// The statement has the shape of what Prisma writes for that filter (the store first, then the OR of the columns, newest first, a
// page). The policy is added to the table inside a transaction that is always rolled back, and both plans are read as platform_app
// with the context of the same store, so the only difference between them is the policy. The ORDERS list is not measured here: the
// first version compared it and it passed, but its statement (a prefix LIKE and a sub-select) is not one the planner reads the same way
// run after run, and a comparison that depends on the statistics proves nothing in either direction (plan-notas-76.md).

const ROWS_PER_STORE = 15_000
const CHUNK = 5_000

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

describe('the plan of the searches of the lists with row-level security on', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  let storeA = ''

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    for (const side of ['a', 'b'] as const) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      if (side === 'a') storeA = store.id
      const customers = Array.from({ length: ROWS_PER_STORE }, (_, i) => ({
        id: randomUUID(),
        storeId: store.id,
        name:
          i % 5000 === 0
            ? `Zorbalux Quintana ${i}`
            : `Cliente ${i} Perez ${randomUUID().slice(0, 6)}`,
        email: `c${i}-${randomUUID().slice(0, 6)}@example.invalid`
      }))
      for (let at = 0; at < customers.length; at += CHUNK) {
        await owner.customer.createMany({ data: customers.slice(at, at + CHUNK) })
      }
    }
    await raw.query('ANALYZE customers')
    // Nothing left for the autovacuum to do while the DDL of the cases below takes its locks (helpers/quiet-tables.ts)
    await quietTables(owner, PLAN_SPEC_TABLES)
  }, 180_000)

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  }, 120_000)

  // The plan of a statement as platform_app with the context of store A, with or without the policies on the tables it reads
  const planOf = (
    statement: string,
    values: unknown[],
    tables: string[],
    policiesOn: boolean
  ): Promise<PlanNode> => retryOnDeadlock(() => planOfOnce(statement, values, tables, policiesOn))
  async function planOfOnce(
    statement: string,
    values: unknown[],
    tables: string[],
    policiesOn: boolean
  ): Promise<PlanNode> {
    try {
      await raw.query('BEGIN')
      await raw.query("SET LOCAL lock_timeout = '20s'")
      if (policiesOn) {
        for (const table of tables) {
          await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
          await raw.query(`DROP POLICY IF EXISTS list_plan ON ${table}`)
          // The policy of the platform for a table scoped by store (rls_apply_policy): the store of the context, as a sub-select
          await raw.query(
            `CREATE POLICY list_plan ON ${table} AS PERMISSIVE FOR SELECT TO ${DatabaseRoles.APP}
               USING (store_id = ANY ((SELECT app_store_ids())::text[]))`
          )
        }
      }
      // Only the bitmaps of the indexes are left to the planner, so that what it can use shows, not what it prefers by the statistics
      await raw.query('SET LOCAL enable_seqscan = off')
      await raw.query('SET LOCAL enable_indexscan = off')
      await raw.query('SET LOCAL enable_indexonlyscan = off')
      await raw.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
      await raw.query("SELECT set_config('app.store_ids', $1, true)", [storeA])
      const { rows } = await raw.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (FORMAT JSON) ${statement}`,
        values
      )
      return rows[0]?.['QUERY PLAN'][0]?.Plan ?? { 'Node Type': 'none' }
    } finally {
      await raw.query('ROLLBACK')
    }
  }

  // How the plan reads the tables: the kind of each scan and the index it goes through, in a stable order. The costs and the row
  // estimates are not part of it (the policy adds a condition, and the numbers move), only the access path.
  function accessPath(node: PlanNode): string[] {
    const own = /Scan$/.test(node['Node Type'])
      ? [`${node['Node Type']} ${node['Relation Name'] ?? ''} ${node['Index Name'] ?? ''}`.trim()]
      : []
    return [...own, ...(node.Plans ?? []).flatMap(accessPath)].sort()
  }

  // The names of the trigram indexes a plan reads (a bitmap over the whole OR of the columns of the search)
  function trigramIndexes(node: PlanNode): string[] {
    return accessPath(node).filter(path => /_trgm|idx_customers_phone/.test(path))
  }

  // The customers list: MEASURED in CI (main, run 44430489099 of #735): with the policies off the planner read the OR of name, email and
  // phone through the trigram indexes (a BitmapOr), and with the policy on through customers_store_id_idx and a filter: the LIKE / ILIKE
  // of the search are not LEAKPROOF, so next to a policy they cannot be index conditions. WHICH plan it picks without a policy depends on
  // the statistics (the first run of the PR read the store index in both, and with the scans switched off the baseline did not read
  // the trigram either), so the baseline is NOT asserted: it travels in the failure, with the plan of the policy, for who reads it.
  // What does not depend on the statistics is the other side: with the policy on no plan can read a trigram index for these operators.
  // That is the gap, and this case records it for the raw statement of the list. It is not turned around by plan B (the list then goes
  // through a function, whose plan is measured in the spec of its own, like the one of the search of the inbox): it stays as the reason
  // the list cannot keep the raw statement once the policies are enforced (plan-notas-76.md, owner BU).
  it('customers list: with the policy on the raw search statement cannot read a trigram index (plan B pending)', async () => {
    const statement = `SELECT c.id FROM customers c
        WHERE c.store_id = $1 AND c.merged_into_id IS NULL
          AND (c.name_search LIKE $2 OR c.email ILIKE $3 OR c.phone_normalized LIKE $4)
        ORDER BY c.created_at DESC, c.id DESC LIMIT 25`
    const values = [storeA, '%zorbalux%', '%zorbalux%', '%5030000%']
    const off = await planOf(statement, values, ['customers'], false)
    const on = await planOf(statement, values, ['customers'], true)
    // Both plans travel with a failure
    expect({
      on: trigramIndexes(on),
      baselineTrigram: trigramIndexes(off),
      plans: { off: JSON.stringify(off), on: JSON.stringify(on) }
    }).toMatchObject({ on: [] })
  })
  // The customers list through its FUNCTION (migration rls_search_customer_list): the deployment as production has it, the function
  // owned by a role that is NOT a superuser and does not bypass row security, the table FORCED, and what lets the function read is the
  // `<table>_owner` policy of that role. Everything is rolled back with the transaction (DDL is transactional). The plan is the one of
  // the statement INSIDE the function (auto_explain, which the owner of the database, a superuser in CI, loads); the call is made as
  // platform_app with the context of store A. The scans that are not bitmaps are switched off with SET LOCAL inside the transaction of
  // the case (it rolls back: nothing leaks to other cases or to the pooler), so the plan shows what the planner CAN read, and
  // what is asserted is what does NOT depend on the statistics (MEASURED in CI: the planner read the store index and filtered, by cost,
  // with the same function): the statement inside the function carries NO policy (no sub-select of app_store_ids(), no InitPlan or
  // SubPlan) and the store is a CONSTANT of the plan (`v_stores` read once), so nothing next to the LIKE bars a trigram index from the
  // planner, which is the gap of the raw case above. Which index it then picks is its cost decision and is not asserted (plan-notas-76).
  it('customers list through its function: no policy barrier next to the search, the store a constant, owner not a superuser', async () => {
    const plan = await retryOnDeadlock(async () => {
      const plans: string[] = []
      const collect = (notice: { message?: string }): void => {
        plans.push(notice.message ?? '')
      }
      raw.on('notice', collect)
      try {
        await raw.query('BEGIN')
        await raw.query("SET LOCAL lock_timeout = '20s'")
        const role = `plan_owner_${prefix.replaceAll(/[^a-z0-9]/gi, '_')}`.slice(0, 60)
        await raw.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
        await raw.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`)
        await raw.query(`GRANT SELECT ON customers TO ${role}`)
        await raw.query('ALTER TABLE customers ENABLE ROW LEVEL SECURITY')
        await raw.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY')
        await raw.query('DROP POLICY IF EXISTS plan_owner ON customers')
        await raw.query(
          `CREATE POLICY plan_owner ON customers AS PERMISSIVE FOR ALL TO ${role} USING (true) WITH CHECK (true)`
        )
        await raw.query(
          `ALTER FUNCTION public.rls_search_customer_list(text, text, text, boolean, text, text, integer) OWNER TO ${role}`
        )
        await raw.query('SET LOCAL enable_seqscan = off')
        await raw.query('SET LOCAL enable_indexscan = off')
        await raw.query('SET LOCAL enable_indexonlyscan = off')
        await raw.query("LOAD 'auto_explain'")
        await raw.query('SET LOCAL auto_explain.log_min_duration = 0')
        await raw.query('SET LOCAL auto_explain.log_nested_statements = on')
        await raw.query('SET LOCAL client_min_messages = log')
        await raw.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
        await raw.query("SELECT set_config('app.store_ids', $1, true)", [storeA])
        const { rows } = await raw.query<{ id: string }>(
          `SELECT f.id FROM public.rls_search_customer_list($1, $2, $3, false, NULL, NULL, 25) AS f`,
          ['%zorbalux%', '%zorbalux%', '%5030000%']
        )
        // Both stores hold the same three Zorbalux: three rows (not six) says that the other store is never read
        expect(rows).toHaveLength(3)
      } finally {
        await raw.query('ROLLBACK')
        raw.off('notice', collect)
      }
      return plans.join('\n')
    })
    // The whole plan travels with the failure
    expect(plan).toContain(`store_id = ANY ('{${storeA}}'::text[])`)
    expect(plan).not.toMatch(/app_store_ids|InitPlan|SubPlan/)
    expect(plan).not.toMatch(/Seq Scan on customers/)
  }, 60_000)
  // The ORDERS list: its search is a prefix LIKE on the number OR the orders of the customers whose name, email or phone match (a
  // sub-select on customers, the same LIKE / ILIKE as above). The first version compared it with and without policy and passed by the
  // statistics, which proved nothing, so what is measured here is the side that does not depend on them: the scans that are not bitmaps
  // are switched off (SET LOCAL, inside the transaction that rolls back) and, with the policy ON, no plan can read a trigram index of
  // the customers for these operators. The baseline without policy is NOT asserted (it travels in the failure). The orders list
  // reads the customers through the policy of that table, so it has the gap of the customers list: it needs its own plan B before the
  // policies are enforced (plan of the step 7.3 owner, see the notes of the PR).
  it('orders list: with the policy on the raw search statement cannot read a trigram index of the customers (plan B pending)', async () => {
    const statement = `SELECT o.id FROM orders o
        WHERE o.store_id = $1
          AND (o.order_number LIKE $2
            OR o.customer_id IN (SELECT c.id FROM customers c WHERE c.store_id = $1
              AND (c.name ILIKE $3 OR c.email ILIKE $3 OR c.phone_normalized LIKE $4)))
        ORDER BY o.created_at DESC, o.id DESC LIMIT 25`
    const values = [storeA, '00012%', '%zorbalux%', '%5030000%']
    const off = await planOf(statement, values, ['orders', 'customers'], false)
    const on = await planOf(statement, values, ['orders', 'customers'], true)
    expect({
      on: trigramIndexes(on),
      baselineTrigram: trigramIndexes(off),
      plans: { off: JSON.stringify(off), on: JSON.stringify(on) }
    }).toMatchObject({ on: [] })
  })
})
