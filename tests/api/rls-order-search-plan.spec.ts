import pg from 'pg'

import {
  connectionUrls,
  ensureStore,
  type OwnerClient,
  DatabaseRoles
} from '@platform/core/database-testing'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { retryOnDeadlock } from '../helpers/deadlock-retry'

// The ORDERS list finds an order by its number (a prefix on `orders`) or by who it is for: the name, the e-mail or the phone of the
// customer, which is a LIKE / ILIKE over `customers`. With row-level security on, those operators are not LEAKPROOF and cannot be index
// conditions next to the policy, so the customers of the text are found by the definer function `rls_search_order_customers`
// (migration 20270122600000). This spec measures both sides over 10000 customers per store, the plan and not the time:
//  - the GAP: the raw sub-select, as platform_app with the policy on, can read no trigram index (the planner can only filter by store);
//  - the FIX: the statement INSIDE the function, owned by a role that is not a superuser and does not bypass row security, over the table
//    FORCED (what lets it read is the `<table>_owner` policy of that role, as in production), reads the trigram indexes.
// The scans that are not bitmaps are switched off with SET LOCAL inside the transaction of each case (it is rolled back: nothing leaks to
// other cases or to the pooler), so the plan shows what the planner CAN read and not what it prefers by the statistics. What is
// asserted is only what does not depend on them. The baseline without a policy is NOT asserted (it travels in the failure).

const ROWS_PER_STORE = 10_000

interface PlanNode {
  'Node Type': string
  'Relation Name'?: string
  'Index Name'?: string
  Plans?: PlanNode[]
}

describe('the plan of the customers of an orders search with row-level security on', () => {
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
      // Every five-thousandth customer (two per store) carries the rare word the cases look for; the rest are random text, so a trigram is selective
      await raw.query(
        `INSERT INTO customers (id, store_id, name, email, phone_normalized, updated_at)
         SELECT gen_random_uuid()::text, $1,
                CASE WHEN i % 5000 = 0 THEN 'Zorbalux Quintana ' || i ELSE 'Cliente ' || i || ' ' || md5(random()::text) END,
                'c' || i || '-' || substr(md5(random()::text), 1, 8) || '@example.invalid',
                '503' || lpad(i::text, 8, '0'),
                now()
         FROM generate_series(1, $2::int) AS i`,
        [store.id, ROWS_PER_STORE]
      )
    }
    await raw.query('ANALYZE customers')
  }, 180_000)

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  }, 120_000)

  const NAME = '%zorbalux%'
  const PHONE = '%50300005000%'

  async function setUpPlanTransaction(): Promise<void> {
    await raw.query('BEGIN')
    await raw.query("SET LOCAL lock_timeout = '20s'")
    await raw.query('SET LOCAL enable_seqscan = off')
    await raw.query('SET LOCAL enable_indexscan = off')
    await raw.query('SET LOCAL enable_indexonlyscan = off')
  }

  function accessPath(node: PlanNode): string[] {
    const own = /Scan$/.test(node['Node Type'])
      ? [`${node['Node Type']} ${node['Relation Name'] ?? ''} ${node['Index Name'] ?? ''}`.trim()]
      : []
    return [...own, ...(node.Plans ?? []).flatMap(accessPath)].sort()
  }

  const trigramIndexes = (node: PlanNode): string[] =>
    accessPath(node).filter(path => /_trgm/.test(path))

  // The raw statement of the sub-select, as platform_app with the context of store A, with the policy of the table on or off
  const rawPlan = (policyOn: boolean): Promise<PlanNode> =>
    retryOnDeadlock(() => rawPlanOnce(policyOn))
  async function rawPlanOnce(policyOn: boolean): Promise<PlanNode> {
    try {
      await setUpPlanTransaction()
      if (policyOn) {
        await raw.query('ALTER TABLE customers ENABLE ROW LEVEL SECURITY')
        await raw.query('DROP POLICY IF EXISTS order_plan ON customers')
        await raw.query(
          `CREATE POLICY order_plan ON customers AS PERMISSIVE FOR SELECT TO ${DatabaseRoles.APP}
             USING (store_id = ANY ((SELECT app_store_ids())::text[]))`
        )
      }
      await raw.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
      await raw.query("SELECT set_config('app.store_ids', $1, true)", [storeA])
      const { rows } = await raw.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (FORMAT JSON) SELECT c.id FROM customers c
          WHERE c.store_id = $1 AND (c.name ILIKE $2 OR c.email ILIKE $2 OR c.phone_normalized LIKE $3)`,
        [storeA, NAME, PHONE]
      )
      return rows[0]?.['QUERY PLAN'][0]?.Plan ?? { 'Node Type': 'none' }
    } finally {
      await raw.query('ROLLBACK')
    }
  }

  it('the raw sub-select with the policy on cannot read a trigram index of the customers', async () => {
    const off = await rawPlan(false)
    const on = await rawPlan(true)
    // Both plans travel with a failure
    expect({
      on: trigramIndexes(on),
      baselineTrigram: trigramIndexes(off),
      plans: { off: JSON.stringify(off), on: JSON.stringify(on) }
    }).toMatchObject({ on: [] })
  })

  it('the function reads the customers with no policy barrier, as a non-superuser owner of a FORCED table', async () => {
    const plan = await retryOnDeadlock(async () => {
      const plans: string[] = []
      const collect = (notice: { message?: string }): void => {
        plans.push(notice.message ?? '')
      }
      raw.on('notice', collect)
      try {
        await setUpPlanTransaction()
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
          `ALTER FUNCTION public.rls_search_order_customers(text, text, text, integer) OWNER TO ${role}`
        )
        await raw.query("LOAD 'auto_explain'")
        await raw.query('SET LOCAL auto_explain.log_min_duration = 0')
        await raw.query('SET LOCAL auto_explain.log_nested_statements = on')
        await raw.query('SET LOCAL client_min_messages = log')
        await raw.query(`SET LOCAL ROLE ${DatabaseRoles.APP}`)
        await raw.query("SELECT set_config('app.store_ids', $1, true)", [storeA])
        const { rows } = await raw.query<{ id: string }>(
          `SELECT f.id FROM public.rls_search_order_customers($1, $1, $2, 101) AS f`,
          [NAME, PHONE]
        )
        // Both stores hold the same two Zorbalux: two rows (not four) says that the other store is never read
        expect(rows).toHaveLength(2)
      } finally {
        await raw.query('ROLLBACK')
        raw.off('notice', collect)
      }
      return plans.join('\n')
    })
    // What does not depend on the statistics (MEASURED in the CI of the customers list, same shape: the planner read the store index and
    // filtered, by cost): the statement inside the function carries NO policy (no sub-select of app_store_ids(), no InitPlan or SubPlan)
    // and the store is a CONSTANT of the plan, so nothing next to the LIKE bars the trigram indexes from the planner. Which one it picks
    // is its cost decision and is not asserted.
    expect(plan).toContain(`store_id = ANY ('{${storeA}}'::text[])`)
    expect(plan).not.toMatch(/app_store_ids|InitPlan|SubPlan/)
    expect(plan).not.toMatch(/Seq Scan on customers/)
  }, 60_000)
})
