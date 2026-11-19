import { randomUUID } from 'node:crypto'

import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

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
  }, 180_000)

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  }, 120_000)

  // The plan of a statement as platform_app with the context of store A, with or without the policies on the tables it reads
  async function planOf(
    statement: string,
    values: unknown[],
    tables: string[],
    policiesOn: boolean
  ): Promise<PlanNode> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      if (policiesOn) {
        for (const table of tables) {
          await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
          await raw.query(`DROP POLICY IF EXISTS list_plan ON ${table}`)
          // The policy of the platform for a table scoped by store (rls_apply_policy): the store of the context, as a sub-select
          await raw.query(
            `CREATE POLICY list_plan ON ${table} AS PERMISSIVE FOR SELECT TO platform_app
               USING (store_id = ANY ((SELECT app_store_ids())::text[]))`
          )
        }
      }
      // Only the bitmaps of the indexes are left to the planner, so that what it can use shows, not what it prefers by the statistics
      await raw.query('SET LOCAL enable_seqscan = off')
      await raw.query('SET LOCAL enable_indexscan = off')
      await raw.query('SET LOCAL enable_indexonlyscan = off')
      await raw.query('SET LOCAL ROLE platform_app')
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
  // of the search are not LEAKPROOF, so next to a policy they cannot be index conditions. Which one it picks without a policy depends on
  // the statistics (the first run of the PR read the store index in both), so the case does not leave the choice to the planner: the
  // sequential and the plain index scan are switched off for both plans, which leaves the bitmaps of the trigram indexes for the plan
  // with no policy and nothing but the store for the plan with it. The first assertion is that the baseline can use them at all.
  // The second records the gap: the day the customers list goes through a read-only SECURITY DEFINER function (as the search of the
  // inbox does, migration rls_search_functions) the policy is the explicit store inside it, the trigram serves the list again, and this
  // case is turned around. Enforcement must not be switched on before that (plan-notas-76.md, owner BU).
  it('customers list: the policy takes the trigram indexes away from the search (known gap, plan B pending)', async () => {
    const statement = `SELECT c.id FROM customers c
        WHERE c.store_id = $1 AND c.merged_into_id IS NULL
          AND (c.name_search LIKE $2 OR c.email ILIKE $3 OR c.phone_normalized LIKE $4)
        ORDER BY c.created_at DESC, c.id DESC LIMIT 25`
    const values = [storeA, '%zorbalux%', '%zorbalux%', '%5030000%']
    const off = await planOf(statement, values, ['customers'], false)
    const on = await planOf(statement, values, ['customers'], true)
    // Both plans travel with a failure
    expect({ off: trigramIndexes(off).length > 0, plan: JSON.stringify(off) }).toMatchObject({
      off: true
    })
    expect({ on: trigramIndexes(on), plan: JSON.stringify(on) }).toMatchObject({ on: [] })
  })
})
