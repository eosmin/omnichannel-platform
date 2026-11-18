import type { INestApplication } from '@nestjs/common'
import { Redis } from 'ioredis'

import { ApiRoutes } from '@platform/core/api'
import { UserRateLimits, userRateLimitThrottler } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import { REDIS_URL } from '../../libs/core/redis/src/testing/test-env'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const TOO_MANY_REQUESTS = 429
const WINDOW_SECONDS = 60

// The second layer of the limit of the routes that can enumerate data (TDD_05 §3.1): per authenticated user, after the guards
describe('The per-user limit of the search and the customer list', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let redis: Redis

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    redis = new Redis(REDIS_URL)
  })
  afterAll(async () => {
    await redis.del(keyOf(ctx.adminA.id), keyOf(ctx.adminB.id))
    redis.disconnect()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const keyOf = (userId: string) =>
    CacheKeys.rateLimit(userRateLimitThrottler(UserRateLimits.SEARCH), userId)
  const search = (actor: typeof ctx.adminA, store: typeof ctx.storeA) =>
    api(app, actor, store).get(ApiRoutes.search.customers).query({ q: 'ab' })

  it('answers 429 with Retry-After once the user spent the budget, and leaves another user alone', async () => {
    await redis.set(
      keyOf(ctx.adminA.id),
      String(UserRateLimits.SEARCH.limit - 1),
      'EX',
      WINDOW_SECONDS
    )

    const last = await search(ctx.adminA, ctx.storeA)
    const over = await search(ctx.adminA, ctx.storeA)
    const other = await search(ctx.adminB, ctx.storeB)

    expect(last.status).toBe(OK)
    expect(over.status).toBe(TOO_MANY_REQUESTS)
    expect((over.body as { error: { code: string } }).error.code).toBe(
      ErrorCodes.RATE_LIMIT_EXCEEDED
    )
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1)
    expect(other.status).toBe(OK)
  })

  it('spends one budget across the search routes, and the customer list has its own', async () => {
    await redis.set(keyOf(ctx.adminA.id), String(UserRateLimits.SEARCH.limit), 'EX', WINDOW_SECONDS)

    const otherSearch = await api(app, ctx.adminA, ctx.storeA)
      .get(ApiRoutes.search.orders)
      .query({ q: 'ab' })
    const list = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.customers.list)

    expect(otherSearch.status).toBe(TOO_MANY_REQUESTS)
    expect(list.status).toBe(OK)
  })

  it('stops the click of a result and the list of customers at their own budget', async () => {
    const clicksKey = CacheKeys.rateLimit(
      userRateLimitThrottler(UserRateLimits.SEARCH_CLICKS),
      ctx.adminA.id
    )
    const listKey = CacheKeys.rateLimit(
      userRateLimitThrottler(UserRateLimits.CUSTOMER_LIST),
      ctx.adminA.id
    )
    await redis.set(clicksKey, String(UserRateLimits.SEARCH_CLICKS.limit), 'EX', WINDOW_SECONDS)
    await redis.set(listKey, String(UserRateLimits.CUSTOMER_LIST.limit), 'EX', WINDOW_SECONDS)
    try {
      const click = await api(app, ctx.adminA, ctx.storeA).post(ApiRoutes.search.clicks).send({})
      const list = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.customers.list)

      expect(click.status).toBe(TOO_MANY_REQUESTS)
      expect(list.status).toBe(TOO_MANY_REQUESTS)
    } finally {
      await redis.del(clicksKey, listKey)
    }
  })
})
