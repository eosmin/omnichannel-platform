import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'

import { RedisThrottlerStorage } from './redis-throttler.storage'
import { REDIS_URL } from './testing/test-env'

const WINDOW_MS = 60_000
const SHORT_MS = 400 // A window or a block short enough to wait for
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('RedisThrottlerStorage', () => {
  const redis = new Redis(REDIS_URL)
  const otherReplica = new Redis(REDIS_URL)
  const storage = new RedisThrottlerStorage(redis)
  const name = `it-${randomUUID().slice(0, 8)}`
  const keys: string[] = []
  const newKey = (): string => {
    const key = randomUUID()
    keys.push(key)
    return key
  }

  afterAll(async () => {
    const found = await redis.keys(`rl:${name}:*`)
    if (found.length > 0) await redis.del(...found)
    await Promise.all([redis.quit(), otherReplica.quit()])
  })

  it('counts the hits of a window and lets through up to the limit', async () => {
    const key = newKey()

    const hits = []
    for (let i = 0; i < 3; i += 1) hits.push(await storage.increment(key, WINDOW_MS, 3, 0, name))

    expect(hits.map(hit => hit.totalHits)).toEqual([1, 2, 3])
    expect(hits.every(hit => !hit.isBlocked)).toBe(true)
    expect(hits[0]?.timeToExpire).toBeGreaterThan(55)
    expect(hits[0]?.timeToExpire).toBeLessThanOrEqual(60)
  })

  it('refuses the first request past the limit and every one after it', async () => {
    const key = newKey()
    for (let i = 0; i < 2; i += 1) await storage.increment(key, WINDOW_MS, 2, 0, name)

    const over = await storage.increment(key, WINDOW_MS, 2, 0, name)
    const after = await storage.increment(key, WINDOW_MS, 2, 0, name)

    expect(over).toMatchObject({ totalHits: 3, isBlocked: true })
    expect(over.timeToBlockExpire).toBeGreaterThan(0)
    expect(after.isBlocked).toBe(true)
  })

  it('keeps a block for its own duration, without counting the requests it refuses', async () => {
    const key = newKey()
    await storage.increment(key, WINDOW_MS, 1, 5000, name)
    const first = await storage.increment(key, WINDOW_MS, 1, 5000, name)
    const second = await storage.increment(key, WINDOW_MS, 1, 5000, name)

    expect(first).toMatchObject({ isBlocked: true, totalHits: 2 })
    expect(first.timeToBlockExpire).toBeGreaterThan(3)
    expect(second.totalHits).toBe(2) // Refused while blocked: not counted
    expect(second.isBlocked).toBe(true)
  })

  it('lets a client through again once the window has passed', async () => {
    const key = newKey()
    await storage.increment(key, SHORT_MS, 1, 0, name)
    expect((await storage.increment(key, SHORT_MS, 1, 0, name)).isBlocked).toBe(true)

    await sleep(SHORT_MS * 3) // Wide margin: a slow runner must not make this flaky

    expect(await storage.increment(key, SHORT_MS, 1, 0, name)).toMatchObject({
      totalHits: 1,
      isBlocked: false
    })
  })

  it('lets a client through again once the block has passed', async () => {
    const key = newKey()
    await storage.increment(key, SHORT_MS, 1, SHORT_MS, name)
    expect((await storage.increment(key, SHORT_MS, 1, SHORT_MS, name)).isBlocked).toBe(true)

    await sleep(SHORT_MS * 3)

    expect((await storage.increment(key, SHORT_MS, 1, SHORT_MS, name)).isBlocked).toBe(false)
  })

  it('counts each client apart', async () => {
    const a = newKey()
    const b = newKey()
    await storage.increment(a, WINDOW_MS, 1, 0, name)

    expect((await storage.increment(a, WINDOW_MS, 1, 0, name)).isBlocked).toBe(true)
    expect((await storage.increment(b, WINDOW_MS, 1, 0, name)).isBlocked).toBe(false)
  })

  it('counts every hit when requests arrive at the same time, from several replicas', async () => {
    const key = newKey()
    const second = new RedisThrottlerStorage(otherReplica)
    const calls = Array.from({ length: 40 }, (_unused, index) =>
      (index % 2 === 0 ? storage : second).increment(key, WINDOW_MS, 25, 0, name)
    )

    const results = await Promise.all(calls)

    expect(results.filter(result => !result.isBlocked)).toHaveLength(25) // None lost, none extra
    expect(results.filter(result => result.isBlocked)).toHaveLength(15)
  })

  it('rolls a window that lost its expiry, so a key can never be stuck refusing forever', async () => {
    const key = newKey()
    await storage.increment(key, WINDOW_MS, 1, 0, name)
    await redis.persist(`rl:${name}:${key}`) // As if something removed the TTL

    const result = await storage.increment(key, WINDOW_MS, 1, 0, name)

    expect(result.timeToExpire).toBeGreaterThan(0)
    expect(await redis.pttl(`rl:${name}:${key}`)).toBeGreaterThan(0)
  })
})
