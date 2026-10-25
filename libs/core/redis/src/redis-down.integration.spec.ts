import { Test, type TestingModule } from '@nestjs/testing'
import { z } from 'zod'

import { CacheService } from './cache.service'
import { RedisThrottlerStorage } from './redis-throttler.storage'
import { REDIS_CLIENT, RedisModule } from './redis.module'

// Redis that refuses connections. The client of the module is what the cache and the rate limit of
// every request go through: if a command waited for it to come back (ioredis does so for 73 seconds
// by default), every request of the platform would hang while Redis is down.
const DEAD_URL = 'redis://127.0.0.1:1'
const FAST_ENOUGH_MS = 3000

describe('the Redis of the platform when it is down', () => {
  let moduleRef: TestingModule

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [RedisModule.forRoot({ url: DEAD_URL })]
    }).compile()
    await moduleRef.init()
  })
  afterAll(() => moduleRef.close())

  it('lets the cache load from the source in well under a second, not after minutes', async () => {
    const cache = moduleRef.get(CacheService)
    const started = Date.now()

    const value = await cache.getOrSet({
      namespace: 'it',
      key: 'it:down',
      ttlSeconds: 30,
      schema: z.object({ name: z.string() }),
      load: () => Promise.resolve({ name: 'from the source' })
    })

    expect(value).toEqual({ name: 'from the source' })
    expect(Date.now() - started).toBeLessThan(FAST_ENOUGH_MS)
  })

  it('fails the rate limit counter fast, so that its guard can let the request through', async () => {
    const storage = new RedisThrottlerStorage(moduleRef.get(REDIS_CLIENT))
    const started = Date.now()

    await expect(storage.increment('k', 60_000, 5, 0, 'it-down')).rejects.toThrow()

    expect(Date.now() - started).toBeLessThan(FAST_ENOUGH_MS)
  })

  it('fails an invalidation fast and loudly', async () => {
    const started = Date.now()

    await expect(moduleRef.get(CacheService).del('it:down')).rejects.toThrow()

    expect(Date.now() - started).toBeLessThan(FAST_ENOUGH_MS)
  })
})
