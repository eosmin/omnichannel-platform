import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { SearchReportConfig, SearchTrackedScopes } from '@platform/core/domain'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// GET /analytics/search (Step 5.2 PR C3): what was searched in the store, read from the events the search leaves. It needs
// analytics:view, filters by the store of the header, looks back a number of whole days, and lists the texts of the catalog
// that found nothing (the only text the events keep).
const DAY_MS = 86_400_000
const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403

interface Report {
  days: number
  scopes: { scope: string; searches: number; zeroResults: number; clicks: number }[]
  zeroResultQueries: { query: string; occurrences: number }[]
}

describe('GET /analytics/search', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  // Each test reads a store of its own: nothing another test wrote is in its counts
  let storeId: string

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    // The events cascade with the store: clearing the ones of store A keeps each test independent
    await owner.analyticsEvent.deleteMany({ where: { storeId: ctx.storeA.id } })
    storeId = ctx.storeA.id
  })

  let sequence = 0
  const hash = (n: number): string => n.toString(16).padStart(16, '0')

  async function event(
    event: string,
    data: Record<string, string | number>,
    options: { ageDays?: number; store?: string } = {}
  ): Promise<void> {
    // Each event is a millisecond after the one before, so "the most recent" of the report is the last one written
    const at = new Date(Date.now() - (options.ageDays ?? 0) * DAY_MS + sequence++)
    await owner.analyticsEvent.create({
      data: {
        storeId: options.store ?? storeId,
        event,
        data,
        date: at,
        timestamp: at,
        eventKey: randomUUID()
      }
    })
  }
  const searched = (
    scope: string,
    resultCount: number,
    extra: Record<string, string | number> = {},
    options: { ageDays?: number; store?: string } = {}
  ) =>
    event(
      AnalyticsEventNames.SEARCH_PERFORMED,
      { queryHash: hash(1), scope, resultCount, durationMs: 5, ...extra },
      options
    )
  const clicked = (scope: string, entity: string) =>
    event(AnalyticsEventNames.SEARCH_CLICKED, { queryHash: hash(1), scope, entity, position: 0 })

  const read = (actor = ctx.adminA, query: Record<string, unknown> = {}, store = ctx.storeA) =>
    api(app, actor, store).get(ApiRoutes.analytics.search).query(query)

  it('has a row for every kind of search, with zeros when nothing was searched', async () => {
    const response = await read()
    expect(response.status).toBe(OK)
    const body = response.body as Report
    expect(body.days).toBe(SearchReportConfig.DEFAULT_DAYS)
    expect(body.scopes.map(row => row.scope)).toEqual(Object.values(SearchTrackedScopes))
    expect(body.scopes.every(row => row.searches + row.zeroResults + row.clicks === 0)).toBe(true)
    expect(body.zeroResultQueries).toEqual([])
  })

  it('counts the searches, the ones that found nothing and the clicks of each kind', async () => {
    await searched('customers', 3)
    await searched('customers', 0)
    await searched('global', 2)
    await searched('global', 0)
    await searched('global', 0)
    await clicked('global', 'orders')
    await clicked('global', 'customers')
    await clicked('customers', 'customers')
    const body = (await read()).body as Report
    const row = (scope: string) => body.scopes.find(item => item.scope === scope)
    expect(row('customers')).toEqual({ scope: 'customers', searches: 2, zeroResults: 1, clicks: 1 })
    expect(row('global')).toEqual({ scope: 'global', searches: 3, zeroResults: 2, clicks: 2 })
    expect(row('orders')).toEqual({ scope: 'orders', searches: 0, zeroResults: 0, clicks: 0 })
  })

  it('looks back the days asked and no further', async () => {
    await searched('orders', 1, {}, { ageDays: 2 })
    await searched('orders', 1, {}, { ageDays: SearchReportConfig.DEFAULT_DAYS - 1 })
    await searched('orders', 1, {}, { ageDays: SearchReportConfig.DEFAULT_DAYS + 10 })
    const orders = (days?: number) =>
      read(ctx.adminA, days === undefined ? {} : { days }).then(
        response => (response.body as Report).scopes.find(row => row.scope === 'orders')?.searches
      )
    expect(await orders(1)).toBe(0)
    expect(await orders(3)).toBe(1)
    expect(await orders()).toBe(2)
    expect(await orders(SearchReportConfig.MAX_DAYS)).toBe(3)
  })

  it('lists the texts of the catalog nobody found, most asked first, one row for a text however it is written', async () => {
    const none = (query: string, n: number, ageDays = 0) =>
      searched('products', 0, { query, queryHash: hash(n) }, { ageDays })
    await none('zapato rojo', 1)
    await none('Zapato  Rojo', 1)
    await none('zapato rojo', 1)
    await none('gorra azul', 2)
    // Past the window, and found something: neither is a gap of the catalog
    await none('sombrero', 3, SearchReportConfig.DEFAULT_DAYS + 10)
    await searched('products', 4, { queryHash: hash(4) })
    const body = (await read()).body as Report
    expect(body.zeroResultQueries).toEqual([
      { query: 'zapato rojo', occurrences: 3 },
      { query: 'gorra azul', occurrences: 1 }
    ])
  })

  it('never lists a text that was kept for another kind of search', async () => {
    // The worker refuses such an event; if one were in the table anyway, the report would still not read it
    await searched('customers', 0, { query: 'maria lopez', queryHash: hash(5) })
    await searched('global', 0, { query: 'maria lopez', queryHash: hash(5) })
    expect(((await read()).body as Report).zeroResultQueries).toEqual([])
  })

  it('stops at the cap of texts', async () => {
    for (let n = 0; n < SearchReportConfig.ZERO_RESULT_LIMIT + 3; n++) {
      await searched('products', 0, { query: `texto ${n}`, queryHash: hash(100 + n) })
    }
    expect(((await read()).body as Report).zeroResultQueries).toHaveLength(
      SearchReportConfig.ZERO_RESULT_LIMIT
    )
  })

  it('reads only the store of the header', async () => {
    await searched('orders', 1, {}, { store: ctx.storeB.id })
    await searched(
      'products',
      0,
      { query: 'solo de B', queryHash: hash(7) },
      { store: ctx.storeB.id }
    )
    try {
      const body = (await read()).body as Report
      expect(body.scopes.every(row => row.searches === 0)).toBe(true)
      expect(body.zeroResultQueries).toEqual([])
      const own = (await read(ctx.adminB, {}, ctx.storeB)).body as Report
      expect(own.zeroResultQueries.map(row => row.query)).toEqual(['solo de B'])
    } finally {
      await owner.analyticsEvent.deleteMany({ where: { storeId: ctx.storeB.id } })
    }
  })

  it('needs analytics:view', async () => {
    expect((await read(ctx.agentA)).status).toBe(FORBIDDEN)
    expect((await read(ctx.adminA)).status).toBe(OK)
  })

  it.each([
    ['no days', { days: 0 }],
    ['more days than the report looks back', { days: SearchReportConfig.MAX_DAYS + 1 }],
    ['a fraction of a day', { days: 1.5 }],
    ['days that are not a number', { days: 'many' }],
    ['a store in the query string', { storeId: randomUUID() }]
  ])('answers 400 to %s', async (_label, query) => {
    expect((await read(ctx.adminA, query)).status).toBe(BAD_REQUEST)
  })
})
