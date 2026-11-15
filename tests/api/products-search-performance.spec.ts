import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { HttpStatusCodes } from '@platform/core/errors'

import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// The "done when" of Step 4.1: the autocomplete answers in under 200 ms (p95) over 5 000 products, and a
// query of "%" returns nothing. A third of the products have two variants, as a clothing store does.
const PRODUCTS = 5000
// The failures seen in CI were isolated stalls, not a slow query: the server-side time of the requests had a median
// of about 40 ms in every query, and one query had a single request of 479 ms. The 95th percentile of 40 samples
// lets two slow requests through and fails on the third (7.5%); over 100 samples it lets five through. The SQL
// itself runs in about 6 ms (EXPLAIN ANALYZE: index scan by store, 5 000 rows filtered), so the limit is not tight.
const REQUESTS = 100
const WARM_UP_REQUESTS = 10
const P95_LIMIT_MS = 200
const ADJECTIVES = ['Classic', 'Urban', 'Light', 'Heavy', 'Soft', 'Sport', 'Slim', 'Retro']
const NOUNS = ['Shirt', 'Shoe', 'Jacket', 'Cap', 'Belt', 'Bag', 'Sock', 'Scarf', 'Pants', 'Dress']
const COLORS = ['Red', 'Blue', 'Black', 'White', 'Green']

const percentile95 = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? Infinity
}

describe('The search of products at the size of a real catalog', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let admin: ReturnType<typeof api>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const storeId = (await ensureStore(owner, ctx.orgA.id, `${prefix}-big`)).id
    admin = api(
      app,
      await createActor(owner, app, {
        prefix,
        name: 'big-admin',
        organizationId: ctx.orgA.id,
        storeId,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      }),
      { id: storeId }
    )
    const rows = Array.from({ length: PRODUCTS }, (_, i) => ({
      id: randomUUID(),
      storeId,
      name: `${ADJECTIVES[i % ADJECTIVES.length]} ${NOUNS[i % NOUNS.length]} ${i}`,
      sku: `SKU-${String(i).padStart(5, '0')}`,
      description: `A ${NOUNS[(i * 3) % NOUNS.length]} for every day, model ${i}`,
      priceCents: 1000 + (i % 90) * 100,
      active: i % 20 !== 0
    }))
    await owner.product.createMany({ data: rows })
    const variants = rows
      .filter((_, i) => i % 3 === 0)
      .flatMap((row, n) =>
        [0, 1].map(k => ({
          productId: row.id,
          name: `${COLORS[(n + k) % COLORS.length]} ${k === 0 ? 'M' : 'L'}`,
          sku: `${row.sku}-${k === 0 ? 'M' : 'L'}`,
          attributes: {}
        }))
      )
    await owner.productVariant.createMany({ data: variants })
    // A real database has statistics and settled pages; a table that was just filled has neither. VACUUM ANALYZE
    // does here, and at once, what autovacuum would do in the middle of the measurement (a stall of the database
    // that one request in the sample pays for)
    await owner.$executeRawUnsafe('VACUUM (ANALYZE) products')
    await owner.$executeRawUnsafe('VACUUM (ANALYZE) product_variants')
  }, 120_000)
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  }, 120_000)

  async function measure(query: string): Promise<number[]> {
    const search = () => admin.get(ApiRoutes.products.search).query({ q: query })
    // The first calls warm the connection pool, the generic plan and the JIT of the handlers
    for (let i = 0; i < WARM_UP_REQUESTS; i += 1) await search()
    const times: number[] = []
    for (let i = 0; i < REQUESTS; i += 1) {
      const started = performance.now()
      const response = await search()
      times.push(performance.now() - started)
      expect(response.status).toBe(HttpStatusCodes.OK)
    }
    return times
  }

  it.each([
    ['a word of the name', 'jacket'],
    ['the start of a name', 'classic sh'],
    ['a word and a number', 'shirt 41'],
    ['a sku', 'SKU-0420'],
    ['a part of a sku', '-0420'],
    ['a variant', 'red m'],
    ['a variant sku', '-L'],
    ['two characters', 'sh'],
    ['a text nothing has', 'zzzzzz']
  ])(
    'answers %s in under 200 ms at the 95th percentile',
    async (_label, query) => {
      const times = await measure(query)

      expect(percentile95(times)).toBeLessThan(P95_LIMIT_MS)
    },
    60_000
  )

  it('finds what it should in the big catalog, and nothing for a wildcard', async () => {
    const found = await admin.get(ApiRoutes.products.search).query({ q: 'SKU-00421' })
    const body = found.body as { data: { sku: string }[] }
    expect(body.data.map(item => item.sku)).toContain('SKU-00421')

    for (const text of ['%', '%%', '_', '__', '\\']) {
      const response = await admin.get(ApiRoutes.products.search).query({ q: text })
      expect(response.status).toBe(HttpStatusCodes.OK)
      expect((response.body as { data: unknown[] }).data).toEqual([])
    }
  })
})
