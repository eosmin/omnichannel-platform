import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { OrderSorts } from '@platform/core/domain'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
// Sizes that put the end of a page at every kind of boundary: inside a tie, between two keys, and (7) right between the
// named customer and the ones with no name (they are the first, as the empty name)
const PAGE_SIZES = [2, 3, 7]

interface Seeded {
  id: string
  totalCents: number
  createdAt: Date
  nameSearch: string | null
  // The day of delivery: the same for three orders, another for one, and none (NULL) for the rest
  day: Date | null
}

interface PageBody {
  data: Array<{ id: string; customer: Record<string, unknown> }>
  nextCursor: string | null
  hasMore: boolean
}

// The sorts by total and by customer of GET /orders (Step 7.3, B9): keyset pages that never repeat nor skip a row, with
// the ties that make a sort ambiguous (equal totals, equal names, equal moments) on purpose
describe('Orders list: keyset sorts by total and by customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent: ReturnType<typeof api>
  const seeded: Seeded[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const member = await actorWithPermissions(owner, app, {
      prefix,
      name: `sorter${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW]
    })
    agent = api(app, member, ctx.storeA)
    const author = await owner.membership.findFirstOrThrow({
      where: { storeId: ctx.storeA.id },
      select: { userId: true }
    })
    const sameMoment = new Date('2026-06-01T10:00:00.000Z')
    // Names and totals repeat, three orders share a moment, and one customer has no name
    const rows: Array<[string | null, number, Date]> = [
      ['beto', 5000, sameMoment],
      ['ana', 5000, sameMoment],
      ['ana', 5000, sameMoment],
      ['carla', 100, new Date('2026-06-02T10:00:00.000Z')],
      ['beto', 9900, new Date('2026-06-03T10:00:00.000Z')],
      [null, 5000, new Date('2026-06-04T10:00:00.000Z')],
      ['zoe', 100, new Date('2026-06-05T10:00:00.000Z')],
      ['ana', 100, new Date('2026-06-05T10:00:00.000Z')],
      [null, 9900, new Date('2026-06-06T10:00:00.000Z')]
    ]
    for (const [name, totalCents, createdAt] of rows) {
      const customer = await owner.customer.create({
        data: { storeId: ctx.storeA.id, name },
        select: { id: true, nameSearch: true }
      })
      const order = await owner.order.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          orderNumber: `S-${randomUUID().slice(0, 8)}`,
          status: 'PENDING_CONFIRMATION',
          subtotalCents: totalCents,
          totalCents,
          paymentMethod: 'CASH',
          recipientPhones: ['71234567'],
          createdBy: author.userId,
          createdAt
        },
        select: { id: true }
      })
      // Three orders share a day, one has another, and the rest have none: equal keys and NULLs in the same sort
      const position = seeded.length
      const day =
        position < 3 ? new Date('2026-12-01') : position === 3 ? new Date('2026-12-02') : null
      if (day !== null) {
        await owner.order.update({ where: { id: order.id }, data: { scheduledDeliveryDate: day } })
      }
      seeded.push({ id: order.id, totalCents, createdAt, nameSearch: customer.nameSearch, day })
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const byNewestThenId = (a: Seeded, b: Seeded): number =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)

  const expected: Record<string, (a: Seeded, b: Seeded) => number> = {
    // Soonest day first, the orders with no day (NULL) last, then the newest and the id
    [OrderSorts.SCHEDULED_DELIVERY]: (a, b) => {
      if (a.day === null && b.day !== null) return 1
      if (a.day !== null && b.day === null) return -1
      return (a.day?.getTime() ?? 0) - (b.day?.getTime() ?? 0) || byNewestThenId(a, b)
    },
    [OrderSorts.TOTAL_HIGHEST]: (a, b) => b.totalCents - a.totalCents || byNewestThenId(a, b),
    [OrderSorts.CUSTOMER_NAME]: (a, b) => {
      // A customer without a name has the empty search name: first
      const [nameA, nameB] = [a.nameSearch ?? '', b.nameSearch ?? '']
      if (nameA !== nameB) return nameA < nameB ? -1 : 1
      return byNewestThenId(a, b)
    }
  }

  async function everyPage(sort: string, size: number): Promise<string[]> {
    const ids: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < seeded.length; pages += 1) {
      const query = `sort=${sort}&limit=${size}${cursor === null ? '' : `&cursor=${cursor}`}`
      const response = await agent.get(`${ApiRoutes.orders.list}?${query}`)
      expect(response.status).toBe(OK)
      const body = response.body as PageBody
      ids.push(...body.data.map(row => row.id))
      if (!body.hasMore) return ids
      cursor = body.nextCursor
    }
    throw new Error('the pages did not end')
  }

  const cases = [
    OrderSorts.TOTAL_HIGHEST,
    OrderSorts.CUSTOMER_NAME,
    OrderSorts.SCHEDULED_DELIVERY
  ].flatMap(sort => PAGE_SIZES.map(size => [sort, size] as const))
  it.each(cases)(
    'pages the sort %s by %i without repeating nor skipping a row, in the order of its keys and ties',
    async (sort, size) => {
      const ids = await everyPage(sort, size)
      const wanted = seeded
        .slice()
        .sort(expected[sort] as (a: Seeded, b: Seeded) => number)
        .map(row => row.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toEqual(wanted)
    }
  )

  it('never sends the sort key of the customer to the client', async () => {
    const response = await agent.get(
      `${ApiRoutes.orders.list}?sort=${OrderSorts.CUSTOMER_NAME}&limit=2`
    )
    const body = response.body as PageBody
    for (const row of body.data) expect(Object.keys(row.customer)).not.toContain('nameSearch')
  })

  it('refuses a cursor made with another sort (a 400), whichever way it goes', async () => {
    const byTotal = (
      (await agent.get(`${ApiRoutes.orders.list}?sort=${OrderSorts.TOTAL_HIGHEST}&limit=2`))
        .body as PageBody
    ).nextCursor
    const newest = ((await agent.get(`${ApiRoutes.orders.list}?limit=2`)).body as PageBody)
      .nextCursor
    const crossed = [
      `sort=${OrderSorts.CUSTOMER_NAME}&cursor=${byTotal}`,
      `sort=${OrderSorts.NEWEST}&cursor=${byTotal}`,
      `sort=${OrderSorts.TOTAL_HIGHEST}&cursor=${newest}`
    ]
    for (const query of crossed) {
      expect((await agent.get(`${ApiRoutes.orders.list}?${query}`)).status).toBe(BAD_REQUEST)
    }
  })

  it('keeps the text filter when a cursor is given (the cursor does not replace the filters)', async () => {
    const first = await agent.get(
      `${ApiRoutes.orders.list}?sort=${OrderSorts.TOTAL_HIGHEST}&q=ana&limit=1`
    )
    const body = first.body as PageBody
    const next = await agent.get(
      `${ApiRoutes.orders.list}?sort=${OrderSorts.TOTAL_HIGHEST}&q=ana&limit=5&cursor=${body.nextCursor}`
    )
    const names = [...body.data, ...(next.body as PageBody).data].map(row => row.customer['name'])
    expect(new Set(names)).toEqual(new Set(['ana']))
  })
})
