import pg from 'pg'

import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { ProductMatchKinds, ProductSearchConfig, SearchDatabaseErrors } from '@platform/core/domain'

import { createProduct, createProductVariant } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// The search functions of migration 20270121650000 (plan B of Row-Level Security) for products and variants: the autocomplete
// (rls_search_products) and the text filter of the stock levels (rls_search_product_matches). They run as the owner (SECURITY
// DEFINER) and filter by themselves: the store is the one of the transaction context, so
//  - a call with no store in the context RAISES (never an empty answer that looks like "nothing found");
//  - the context of one store never reads a row of another, with the rows of both in the same tables, and a variant is only ever
//    read through a product of the store;
//  - the statement inside uses the trigram index of what it searches (the reason of the functions: with the policies enforced the
//    planner does not push ILIKE below the policy and the search fell back to the store index);
//  - a temporary table of the caller with the name of a real one changes nothing (the search_path of a definer function).
// The calls are made as platform_app, the role of the api. Limit, as in rls-search-functions.spec: the owner of the tables in these
// suites is a superuser, and a role that owns the tables with FORCE needs its own `<table>_owner` policy, which names the real owner,
// so the case "owner that is not a superuser, with FORCE" cannot be copied here; the policies themselves are covered by
// rls-phase3.spec.ts.

const PRODUCTS_CALL = `SELECT * FROM public.rls_search_products($1::text, $2::text, $3::text, $4::boolean, $5::integer)`
const MATCHES_CALL = `SELECT * FROM public.rls_search_product_matches($1::text, $2::integer, $3::text, $4::text)`

describe('the product search functions of row-level security', () => {
  const prefix = newRunPrefix()
  const urls = connectionUrls()
  let app: Awaited<ReturnType<typeof createTestApp>>
  let owner: OwnerClient
  let ctx: TestContext
  let appDb: pg.Client
  let statsDb: pg.Client
  // A word nobody else's data has, so that the cases only see their own rows
  const tag = `zp${Math.random()
    .toString(36)
    .slice(2, 10)
    .replaceAll(/[^a-z]/g, 'q')}`

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    appDb = new pg.Client({ connectionString: urls.app })
    statsDb = new pg.Client({ connectionString: urls.owner })
    await appDb.connect()
    await statsDb.connect()
  })
  afterAll(async () => {
    await appDb.end()
    await statsDb.end()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // What the tenant interceptor does: one transaction, the context first, transaction-local
  async function inContext<T>(stores: string[], work: () => Promise<T>): Promise<T> {
    await appDb.query('BEGIN')
    try {
      await appDb.query(
        "SELECT set_config('app.store_ids', $1, true), set_config('app.organization_ids', '', true)",
        [stores.join(',')]
      )
      const result = await work()
      await appDb.query('COMMIT')
      return result
    } catch (error) {
      await appDb.query('ROLLBACK')
      throw error
    }
  }

  const productsIn = (stores: string[], text: string, archived = false, limit = 20) =>
    inContext(
      stores,
      async () =>
        (
          await appDb.query<{
            id: string
            variant_id: string | null
            variant_name: string | null
          }>(PRODUCTS_CALL, [text, `${text}%`, `%${text}%`, archived, limit])
        ).rows
    )

  const matchesIn = (stores: string[], text: string, limit = 100) =>
    inContext(
      stores,
      async () =>
        (
          await appDb.query<{ kind: string; id: string }>(MATCHES_CALL, [
            `%${text}%`,
            limit,
            ProductMatchKinds.PRODUCT,
            ProductMatchKinds.VARIANT
          ])
        ).rows
    )

  let seeded = 0
  async function seed() {
    // Each call writes its own skus: the sku of a product is unique in its store
    seeded += 1
    const n = seeded
    const own = await createProduct(owner, {
      storeId: ctx.storeA.id,
      name: `Camisa ${tag}`,
      sku: `SKU-${tag}-A${n}`
    })
    const foreign = await createProduct(owner, {
      storeId: ctx.storeB.id,
      name: `Camisa ${tag}`,
      sku: `SKU-${tag}-B${n}`
    })
    const ownVariant = await createProductVariant(owner, {
      productId: own.id,
      name: `Talla ${tag} M`,
      sku: `VAR-${tag}-A${n}`
    })
    const foreignVariant = await createProductVariant(owner, {
      productId: foreign.id,
      name: `Talla ${tag} M`,
      sku: `VAR-${tag}-B${n}`
    })
    return { own, foreign, ownVariant, foreignVariant }
  }

  it('raises when the transaction has no store in its context, for each function', async () => {
    await appDb.query('BEGIN')
    try {
      for (const [call, args] of [
        [PRODUCTS_CALL, [tag, `${tag}%`, `%${tag}%`, false, 5]],
        [MATCHES_CALL, [`%${tag}%`, 5, ProductMatchKinds.PRODUCT, ProductMatchKinds.VARIANT]]
      ] as const) {
        await appDb.query('SAVEPOINT s')
        await expect(appDb.query(call, [...args])).rejects.toThrow(
          SearchDatabaseErrors.CONTEXT_REQUIRED
        )
        await appDb.query('ROLLBACK TO SAVEPOINT s')
      }
    } finally {
      await appDb.query('ROLLBACK')
    }
  })

  it('finds the products of the store of the context and never those of another store', async () => {
    const { own, foreign } = await seed()
    const asA = (await productsIn([ctx.storeA.id], tag)).map(row => row.id)
    expect(asA).toContain(own.id)
    expect(asA).not.toContain(foreign.id)
    const asB = (await productsIn([ctx.storeB.id], tag)).map(row => row.id)
    expect(asB).toContain(foreign.id)
    expect(asB).not.toContain(own.id)
  })

  it('names the variant that is the reason a product is in the answer, and only a variant of that product', async () => {
    const own = await createProduct(owner, { storeId: ctx.storeA.id, name: `Pantalon base ${tag}` })
    const foreign = await createProduct(owner, { storeId: ctx.storeB.id, name: 'Otro producto' })
    const variant = await createProductVariant(owner, {
      productId: own.id,
      name: `Rojo ${tag}`,
      sku: `RJ-${tag}`
    })
    // The variant of ANOTHER store carries the same text: it must not come in, with its product or on its own
    await createProductVariant(owner, {
      productId: foreign.id,
      name: `Rojo ${tag}`,
      sku: `RJ2-${tag}`
    })
    const rows = await productsIn([ctx.storeA.id], `Rojo ${tag}`)
    expect(rows.map(row => [row.id, row.variant_id])).toEqual([[own.id, variant.id]])
    expect(await productsIn([ctx.storeB.id], `Rojo ${tag}`)).toHaveLength(1)
  })

  it('leaves out the archived products unless they are asked for', async () => {
    const archived = await createProduct(owner, {
      storeId: ctx.storeA.id,
      name: `Archivado ${tag}`,
      active: false
    })
    expect((await productsIn([ctx.storeA.id], `Archivado ${tag}`)).map(row => row.id)).toEqual([])
    expect(
      (await productsIn([ctx.storeA.id], `Archivado ${tag}`, true)).map(row => row.id)
    ).toEqual([archived.id])
  })

  it('answers the products and the variants of the store that match, tagged with the kind, and never those of another store', async () => {
    const { own, foreign, ownVariant, foreignVariant } = await seed()
    const asA = await matchesIn([ctx.storeA.id], tag)
    const idsOf = (rows: Array<{ kind: string; id: string }>, kind: string): string[] =>
      rows.filter(row => row.kind === kind).map(row => row.id)
    expect(idsOf(asA, ProductMatchKinds.PRODUCT)).toContain(own.id)
    expect(idsOf(asA, ProductMatchKinds.PRODUCT)).not.toContain(foreign.id)
    expect(idsOf(asA, ProductMatchKinds.VARIANT)).toContain(ownVariant.id)
    expect(idsOf(asA, ProductMatchKinds.VARIANT)).not.toContain(foreignVariant.id)
    // A caller that names both stores in its context asks for both: the function answers for the whole context
    const both = await matchesIn([ctx.storeA.id, ctx.storeB.id], tag)
    expect(idsOf(both, ProductMatchKinds.PRODUCT)).toEqual(
      expect.arrayContaining([own.id, foreign.id])
    )
  })

  it('answers at most the limit of each kind (so the caller can tell a search that is too wide)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const product = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `Ancho ${tag} ${i}`
      })
      await createProductVariant(owner, { productId: product.id, name: `Ancho ${tag} v${i}` })
    }
    const rows = await matchesIn([ctx.storeA.id], `Ancho ${tag}`, 2)
    expect(rows.filter(row => row.kind === ProductMatchKinds.PRODUCT)).toHaveLength(2)
    expect(rows.filter(row => row.kind === ProductMatchKinds.VARIANT)).toHaveLength(2)
  })

  it('is not fooled by a temporary table of the caller with the name of a real one (the search path of a definer function)', async () => {
    const { own, foreign } = await seed()
    const rows = await inContext([ctx.storeA.id], async () => {
      // platform_app may create temporary tables: these shadow the real ones for any code that does not pin the schema
      await appDb.query(
        'CREATE TEMP TABLE products (id text, store_id text, name text, sku text, price_cents int, image_media_id text, active boolean) ON COMMIT DROP'
      )
      await appDb.query(
        'CREATE TEMP TABLE product_variants (id text, product_id text, name text, sku text, price_cents int, active boolean) ON COMMIT DROP'
      )
      await appDb.query(
        "INSERT INTO pg_temp.products VALUES ('fake', $1, $2, 'x', 1, NULL, true)",
        [ctx.storeB.id, `Camisa ${tag}`]
      )
      const autocomplete = (
        await appDb.query<{ id: string }>(PRODUCTS_CALL, [tag, `${tag}%`, `%${tag}%`, false, 20])
      ).rows.map(row => row.id)
      await appDb.query(
        "INSERT INTO pg_temp.product_variants VALUES ('fake-variant', $1, $2, 'x', 1, true)",
        ['fake', `Camisa ${tag}`]
      )
      // The second function has its own search path: the same trap, the same answer
      const matches = (
        await appDb.query<{ kind: string; id: string }>(MATCHES_CALL, [
          `%${tag}%`,
          100,
          ProductMatchKinds.PRODUCT,
          ProductMatchKinds.VARIANT
        ])
      ).rows.map(row => row.id)
      return { autocomplete, matches }
    })
    expect(rows.autocomplete).toContain(own.id)
    expect(rows.autocomplete).not.toContain('fake')
    expect(rows.autocomplete).not.toContain(foreign.id)
    expect(rows.matches).toContain(own.id)
    expect(rows.matches).not.toEqual(expect.arrayContaining(['fake', 'fake-variant', foreign.id]))
    for (const fake of ['fake', 'fake-variant']) expect(rows.matches).not.toContain(fake)
  })

  it('accepts the biggest limits the api asks for (the bounds of the functions cover the constants of the callers)', async () => {
    await expect(
      productsIn([ctx.storeA.id], tag, false, ProductSearchConfig.MAX_LIMIT)
    ).resolves.toBeDefined()
    await expect(
      matchesIn([ctx.storeA.id], tag, ProductSearchConfig.MAX_FILTER_MATCHES + 1)
    ).resolves.toBeDefined()
  })

  it('refuses a limit that is NULL, zero or too big, instead of answering with no limit', async () => {
    for (const [call, args] of [
      [PRODUCTS_CALL, [tag, `${tag}%`, `%${tag}%`, false, null]],
      [PRODUCTS_CALL, [tag, `${tag}%`, `%${tag}%`, false, 0]],
      [PRODUCTS_CALL, [tag, `${tag}%`, `%${tag}%`, false, 101]],
      [MATCHES_CALL, [`%${tag}%`, null, ProductMatchKinds.PRODUCT, ProductMatchKinds.VARIANT]],
      [MATCHES_CALL, [`%${tag}%`, 10002, ProductMatchKinds.PRODUCT, ProductMatchKinds.VARIANT]]
    ] as const) {
      await expect(inContext([ctx.storeA.id], () => appDb.query(call, [...args]))).rejects.toThrow(
        'SEARCH_LIMIT_INVALID'
      )
    }
  })

  it('can be called by the api and by nobody else', async () => {
    const { rows } = await statsDb.query<{ app: boolean; worker: boolean; pub: boolean }>(
      `SELECT
         has_function_privilege('platform_app', 'public.rls_search_products(text, text, text, boolean, integer)', 'EXECUTE')
           AND has_function_privilege('platform_app', 'public.rls_search_product_matches(text, integer, text, text)', 'EXECUTE') AS app,
         has_function_privilege('platform_worker', 'public.rls_search_products(text, text, text, boolean, integer)', 'EXECUTE')
           OR has_function_privilege('platform_worker', 'public.rls_search_product_matches(text, integer, text, text)', 'EXECUTE') AS worker,
         has_function_privilege('public', 'public.rls_search_products(text, text, text, boolean, integer)', 'EXECUTE')
           OR has_function_privilege('public', 'public.rls_search_product_matches(text, integer, text, text)', 'EXECUTE') AS pub`
    )
    expect(rows[0]).toEqual({ app: true, worker: false, pub: false })
  })
})
