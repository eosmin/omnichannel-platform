import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { AnalyticsEventNames, AnalyticsMetrics } from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import {
  connectionUrls,
  createOwnerClient,
  ensureReplicaDatabase,
  type OwnerClient
} from '@platform/core/database-testing'
import { SearchTrackedScopes } from '@platform/core/domain'

import { createProduct } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// Step 5.3 PR B (TDD_08 §2.5): the api reads a list that tolerates lag from the replica and everything else from the primary.
// The replica here is a second database with the same schema that nothing feeds, so a row put in only one of the two says
// which one answered. Every request goes through the real app (guards included): the members, the roles and the store of
// the primary are NOT in the replica, so a guard that read the replica would answer 401 or 403.
const OK = 200
const REPLICA_SETUP_TIMEOUT = 180_000

interface Suggestions {
  data: { id: string; name: string }[]
}
interface SearchReport {
  zeroResultQueries: { query: string }[]
}
interface Metrics {
  series: { summary: { value: number } }[]
}

describe('read replica routing', () => {
  const prefix = newRunPrefix()
  const tag = `zr${randomUUID().slice(0, 6)}`
  let app: INestApplication
  let owner: OwnerClient
  let replicaOwner: OwnerClient
  let ctx: TestContext
  let onlyInPrimary: { id: string; name: string }
  let onlyInReplica: { id: string; name: string }

  beforeAll(async () => {
    const replica = await ensureReplicaDatabase()
    owner = ownerClient()
    replicaOwner = createOwnerClient(replica.owner)
    // The app talks to the primary as platform_app and to the replica as platform_app too: only the database differs
    const prisma = new PrismaService({
      databaseUrl: connectionUrls().app,
      replicaUrl: replica.app
    })
    app = await createTestApp([], builder =>
      builder.overrideProvider(PrismaService).useValue(prisma)
    )
    ctx = await seedTestContext(owner, app, prefix)

    // The replica knows the store (a row cannot exist without it) and nothing else of the context: no member, no role
    await replicaOwner.organization.create({
      data: { id: ctx.orgA.id, name: `${prefix} replica`, slug: `${prefix}-replica` }
    })
    await replicaOwner.store.create({
      data: {
        id: ctx.storeA.id,
        organizationId: ctx.orgA.id,
        name: 'replica store',
        slug: `${prefix}-replica-store`
      }
    })
    onlyInPrimary = await createProduct(owner, {
      storeId: ctx.storeA.id,
      name: `${tag} primary shoe`
    })
    onlyInReplica = await createProduct(replicaOwner, {
      storeId: ctx.storeA.id,
      name: `${tag} replica shoe`
    })
    await owner.metricDaily.create({
      data: {
        storeId: ctx.storeA.id,
        date: new Date('2026-11-09'),
        metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
        value: 1,
        count: 1
      }
    })
    // A search that found nothing, recorded only in the replica: the report of searches reads it from there
    await replicaOwner.analyticsEvent.create({
      data: {
        storeId: ctx.storeA.id,
        event: AnalyticsEventNames.SEARCH_PERFORMED,
        data: {
          queryHash: 'a'.repeat(16),
          scope: SearchTrackedScopes.PRODUCTS,
          resultCount: 0,
          query: `${tag} nothing`
        },
        date: new Date(),
        timestamp: new Date(),
        eventKey: randomUUID()
      }
    })
    await replicaOwner.metricDaily.create({
      data: {
        storeId: ctx.storeA.id,
        date: new Date('2026-11-09'),
        metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
        value: 5,
        count: 5
      }
    })
  }, REPLICA_SETUP_TIMEOUT)

  afterAll(async () => {
    // A beforeAll that failed leaves some of these undefined: the first error must be the one that is shown
    if (ctx !== undefined)
      await replicaOwner?.organization.deleteMany({ where: { id: ctx.orgA.id } })
    if (owner !== undefined) await cleanUp(owner, prefix)
    await app?.close()
    await replicaOwner?.$disconnect()
    await owner?.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  it('answers the report of searches from the replica', async () => {
    const response = await asAdmin().get(ApiRoutes.analytics.search).query({ days: 7 })

    expect(response.status).toBe(OK)
    expect((response.body as SearchReport).zeroResultQueries.map(row => row.query)).toContain(
      `${tag} nothing`
    )
  })

  it('filters the replica by the store of the request: another store reads none of its rows', async () => {
    const other = api(app, ctx.adminB, ctx.storeB)
    const metrics = await other.get(ApiRoutes.analytics.metrics).query({
      metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z'
    })
    const searches = await other.get(ApiRoutes.analytics.search).query({ days: 7 })

    expect(metrics.status).toBe(OK)
    expect((metrics.body as Metrics).series.flatMap(row => row.summary.value)).not.toContain(5)
    expect(searches.status).toBe(OK)
    expect((searches.body as SearchReport).zeroResultQueries).toEqual([])
  })

  it('keeps every search on the primary: it applies the rules of erasure and of what a person just changed', async () => {
    const response = await asAdmin().get(ApiRoutes.products.search).query({ q: tag })

    expect(response.status).toBe(OK)
    expect((response.body as Suggestions).data.map(item => item.id)).toEqual([onlyInPrimary.id])
    expect(onlyInReplica.id).not.toBe(onlyInPrimary.id)
  })

  it('answers the metrics of the dashboard from the replica', async () => {
    const response = await asAdmin().get(ApiRoutes.analytics.metrics).query({
      metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-10T00:00:00.000Z'
    })

    expect(response.status).toBe(OK)
    expect((response.body as Metrics).series[0]?.summary.value).toBe(5)
  })

  it('keeps the list of products on the primary, which is where a person just wrote', async () => {
    const response = await asAdmin().get(ApiRoutes.products.list).query({ limit: 100 })

    expect(response.status).toBe(OK)
    const ids = (response.body as Suggestions).data.map(item => item.id)
    expect(ids).toContain(onlyInPrimary.id)
    expect(ids).not.toContain(onlyInReplica.id)
  })

  it('keeps a write on the primary: the row it reads before it writes is only there', async () => {
    const response = await asAdmin()
      .patch(ApiRoutes.products.byId(onlyInPrimary.id))
      .send({ name: `${tag} renamed` })

    expect(response.status).toBe(OK)
    const stored = await owner.product.findUnique({ where: { id: onlyInPrimary.id } })
    expect(stored?.name).toBe(`${tag} renamed`)
    // And the replica, which a write never reads from, did not get it
    expect(await replicaOwner.product.findUnique({ where: { id: onlyInPrimary.id } })).toBeNull()
  })
})
