import pg from 'pg'

import { connectionUrls, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { ProductMatchKinds } from '@platform/core/domain'

import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The plan of the search of products and variants with Row-Level Security on (the same question rls-search-plan.spec.ts asks of the
// messages). The trigram operators (ILIKE) are not LEAKPROOF, so with the policies enforced the planner reads the products through the
// index of the store and filters afterwards: a search would read every product of the store. The functions of migration
// 20270121650000 run as the owner of the tables (the policy is then the explicit `store_id = ANY (context)` inside them) and the
// trigram indexes serve the search again. What is asserted is the plan, not the time, over enough rows for an index to be the cheaper
// way: 10 000 products and 5 000 variants in each of two stores, ANALYZEd.
//
// The functions are measured the way they run in production: owned by a role that is NOT a superuser and does not bypass row security,
// over tables that are FORCED, so that what lets the function read is the `<table>_owner` policy of its owner. All of it is rolled back
// (DDL is transactional). The plan of the statement inside the function comes from auto_explain, which the owner of the database (a
// superuser in CI) loads: the outer plan of a call only says "Function Scan".

const PRODUCTS_PER_STORE = 10_000
const NEEDLE_EVERY = 5_000

const MATCHES_CALL = `SELECT * FROM public.rls_search_product_matches($1::text, $2::integer, $3::text, $4::text)`
const PRODUCTS_CALL = `SELECT * FROM public.rls_search_products($1::text, $2::text, $3::text, $4::boolean, $5::integer)`
const MATCHES_FUNCTION = 'public.rls_search_product_matches(text, integer, text, text)'
const PRODUCTS_FUNCTION = 'public.rls_search_products(text, text, text, boolean, integer)'

describe('the plan of the product searches with row-level security on', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  const owner: OwnerClient = ownerClient()
  const raw = new pg.Client({ connectionString: urls.owner })
  const stores: string[] = []
  const needle = 'zorbalux'

  beforeAll(async () => {
    await raw.connect()
    const org = await owner.organization.create({
      data: { name: `${prefix}-org`, slug: `${prefix}-org` }
    })
    for (const side of ['a', 'b']) {
      const store = await ensureStore(owner, org.id, `${prefix}-store-${side}`)
      stores.push(store.id)
      await raw.query(
        `INSERT INTO products (id, store_id, name, sku, price_cents, updated_at)
         SELECT gen_random_uuid()::text, $1,
           CASE WHEN g % ${NEEDLE_EVERY} = 0 THEN 'Zorbalux modelo ' || g
                ELSE 'Producto ' || g || ' ' || substr(md5(random()::text), 1, 8) END,
           'SKU-' || g || '-' || substr(md5(random()::text), 1, 6), 1000, now()
         FROM generate_series(1, ${PRODUCTS_PER_STORE}) g`,
        [store.id]
      )
      await raw.query(
        `INSERT INTO product_variants (id, product_id, name, sku, attributes)
         SELECT gen_random_uuid()::text, p.id, 'Variante ' || p.name, 'V-' || p.sku, '{}'::jsonb
         FROM (SELECT id, name, sku FROM products WHERE store_id = $1 ORDER BY id LIMIT ${PRODUCTS_PER_STORE / 2}) p`,
        [store.id]
      )
    }
    await raw.query('ANALYZE products')
    await raw.query('ANALYZE product_variants')
  }, 180_000)

  afterAll(async () => {
    // By the stores this suite made, never wider: the variants go with their products
    for (const storeId of stores)
      await raw.query('DELETE FROM products WHERE store_id = $1', [storeId])
    await cleanUp(owner, prefix)
    await raw.end().catch(() => undefined)
    await owner.$disconnect()
  }, 180_000)

  // The plan of a plain statement as platform_app with the context of store A; the policies are on or off
  async function planOf(
    statement: string,
    values: unknown[],
    policiesOn: boolean
  ): Promise<string> {
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      if (policiesOn) {
        for (const table of ['products', 'product_variants']) {
          await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
        }
      }
      await raw.query('SET LOCAL ROLE platform_app')
      await raw.query("SELECT set_config('app.store_ids', $1, true)", [stores[0]])
      const { rows } = await raw.query<{ 'QUERY PLAN': unknown }>(
        `EXPLAIN (FORMAT JSON) ${statement}`,
        values
      )
      return JSON.stringify(rows[0]?.['QUERY PLAN'])
    } finally {
      await raw.query('ROLLBACK')
    }
  }

  // The plans auto_explain logs for the statements inside one call of a function, as the non-superuser owner of FORCED tables
  async function planOfFunction(
    functionSignature: string,
    call: string,
    values: unknown[]
  ): Promise<string> {
    const plans: string[] = []
    const collect = (notice: { message?: string }): number => plans.push(notice.message ?? '')
    raw.on('notice', collect)
    await raw.query('BEGIN')
    try {
      await raw.query("SET LOCAL lock_timeout = '20s'")
      const role = `plan_owner_${prefix.replaceAll(/[^a-z0-9]/gi, '_')}`.slice(0, 60)
      await raw.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
      await raw.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`)
      for (const table of ['products', 'product_variants']) {
        await raw.query(`GRANT SELECT ON ${table} TO ${role}`)
        await raw.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
        await raw.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
        await raw.query(`DROP POLICY IF EXISTS plan_owner ON ${table}`)
        await raw.query(
          `CREATE POLICY plan_owner ON ${table} AS PERMISSIVE FOR ALL TO ${role} USING (true) WITH CHECK (true)`
        )
      }
      await raw.query(`ALTER FUNCTION ${functionSignature} OWNER TO ${role}`)
      await raw.query("LOAD 'auto_explain'")
      await raw.query('SET LOCAL auto_explain.log_min_duration = 0')
      await raw.query('SET LOCAL auto_explain.log_nested_statements = on')
      await raw.query('SET LOCAL client_min_messages = log')
      await raw.query("SELECT set_config('app.store_ids', $1, true)", [stores[0]])
      await raw.query(call, values)
    } finally {
      await raw.query('ROLLBACK')
      raw.off('notice', collect)
    }
    return plans.join('\n')
  }

  // The baseline: with the policies off the products DO go through their trigram index. Without it a failure below could be the data.
  it('baseline, policies off: the products of a word are read through the trigram index', async () => {
    const plan = await planOf(
      `SELECT p.id FROM products p WHERE p.store_id = $1 AND (p.name ILIKE $2 ESCAPE '\\' OR p.sku ILIKE $2 ESCAPE '\\')`,
      [stores[0], `%${needle}%`],
      false
    )
    expect(plan).toMatch(/idx_products_(name|sku)_trgm/)
  })

  it('with the policies on, the filter of the stock levels reads products and variants through the trigram indexes', async () => {
    const plan = await planOfFunction(MATCHES_FUNCTION, MATCHES_CALL, [
      `%${needle}%`,
      2001,
      ProductMatchKinds.PRODUCT,
      ProductMatchKinds.VARIANT
    ])
    expect(plan).toMatch(/idx_products_(name|sku)_trgm/)
    expect(plan).toMatch(/idx_product_variants_(name|sku)_trgm/)
    expect(plan).not.toMatch(/Seq Scan on products/)
    expect(plan).not.toMatch(/Seq Scan on product_variants/)
  }, 180_000)

  it('with the policies on, the autocomplete reads products and variants through the trigram indexes', async () => {
    const plan = await planOfFunction(PRODUCTS_FUNCTION, PRODUCTS_CALL, [
      needle,
      `${needle}%`,
      `%${needle}%`,
      false,
      8
    ])
    expect(plan).toMatch(/idx_products_(name|sku)_trgm/)
    expect(plan).toMatch(/idx_product_variants_(name|sku)_trgm/)
    expect(plan).not.toMatch(/Seq Scan on products/)
  }, 180_000)
})
