import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { z } from 'zod'

import { CacheService } from './cache.service'
import { REDIS_URL } from './testing/test-env'

const schema = z.object({ name: z.string() })
type Value = z.output<typeof schema>

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('CacheService', () => {
  // Opened in beforeAll, not here: a run filtered with -t skips the hooks of a block with no test
  // selected, and a connection opened at definition time would never be closed and would hold Jest open
  let redis: Redis
  let cache: CacheService
  const hits: string[] = []
  const misses: string[] = []
  const run = randomUUID().slice(0, 8)
  const created: string[] = []

  // A key and a scope of this run, so that suites in parallel and old runs never meet
  const newKey = (): string => {
    const key = `it:${run}:${randomUUID()}`
    created.push(key)
    return key
  }
  const newScope = (): string => `it:${run}:scope:${randomUUID()}`

  function entry(
    key: string,
    load: () => Promise<Value | null>,
    overrides: { scopes?: string[]; ttlSeconds?: number } = {}
  ): Parameters<typeof cache.getOrSet<Value | null>>[0] {
    return {
      namespace: 'it',
      key,
      ttlSeconds: overrides.ttlSeconds ?? 60,
      schema: schema.nullable(),
      load,
      ...(overrides.scopes === undefined ? {} : { scopes: overrides.scopes })
    }
  }

  beforeAll(() => {
    redis = new Redis(REDIS_URL)
    cache = new CacheService(redis, {
      onHit: namespace => hits.push(namespace),
      onMiss: namespace => misses.push(namespace)
    })
  })

  afterAll(async () => {
    const found = await redis.keys(`cache:v1:*${run}*`)
    if (found.length > 0) await redis.del(...found)
    await redis.quit()
  })

  beforeEach(() => {
    hits.length = 0
    misses.length = 0
  })

  it('loads on a miss, serves the next reads from Redis and says which it was', async () => {
    const key = newKey()
    const load = jest.fn(() => Promise.resolve({ name: 'a' }))

    const first = await cache.getOrSet(entry(key, load))
    const second = await cache.getOrSet(entry(key, load))

    expect([first, second]).toEqual([{ name: 'a' }, { name: 'a' }])
    expect(load).toHaveBeenCalledTimes(1)
    expect(misses).toEqual(['it'])
    expect(hits).toEqual(['it'])
  })

  it('stores under a versioned prefix with the TTL asked for, give or take the spread', async () => {
    const key = newKey()
    await cache.getOrSet(entry(key, () => Promise.resolve({ name: 'a' }), { ttlSeconds: 100 }))

    const ttl = await redis.ttl(`cache:v1:${key}`)

    expect(ttl).toBeGreaterThanOrEqual(89)
    expect(ttl).toBeLessThanOrEqual(111)
  })

  it('caches "nothing there" too, so that asking for what does not exist loads once', async () => {
    const key = newKey()
    const load = jest.fn(() => Promise.resolve(null))

    const results = [
      await cache.getOrSet(entry(key, load)),
      await cache.getOrSet(entry(key, load)),
      await cache.getOrSet(entry(key, load))
    ]

    expect(results).toEqual([null, null, null])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('loads again once the entry has expired', async () => {
    const key = newKey()
    const load = jest.fn(() => Promise.resolve({ name: 'a' }))
    await cache.getOrSet(entry(key, load, { ttlSeconds: 1 }))

    await sleep(1400) // The longest the spread allows is 1.1 s

    await cache.getOrSet(entry(key, load, { ttlSeconds: 1 }))
    expect(load).toHaveBeenCalledTimes(2)
  })

  describe('what Redis returns is not trusted', () => {
    it.each([
      ['text that is not JSON', 'not json at all'],
      ['JSON of another shape', JSON.stringify({ g: 0, v: { other: 1 } })],
      ['JSON without the envelope', JSON.stringify({ name: 'a' })],
      ['a value of the wrong type', JSON.stringify({ g: 0, v: 5 })]
    ])('treats %s as a miss and overwrites it', async (_name, planted) => {
      const key = newKey()
      await redis.set(`cache:v1:${key}`, planted, 'EX', 60)
      const load = jest.fn(() => Promise.resolve({ name: 'fresh' }))

      const value = await cache.getOrSet(entry(key, load))

      expect(value).toEqual({ name: 'fresh' })
      expect(load).toHaveBeenCalledTimes(1)
      expect(JSON.parse((await redis.get(`cache:v1:${key}`)) ?? '{}')).toMatchObject({
        v: { name: 'fresh' }
      })
    })
  })

  describe('what each caller gets', () => {
    it('is a copy of its own: a caller that changes it does not change what the others got', async () => {
      const key = newKey()
      const load = jest.fn(async () => {
        await sleep(50)
        return { name: 'shared' }
      })

      const [first, second] = await Promise.all([
        cache.getOrSet(entry(key, load)),
        cache.getOrSet(entry(key, load))
      ])
      if (first !== null) first.name = 'changed by the first caller'

      expect(first).not.toBe(second)
      expect(second).toEqual({ name: 'shared' })
      expect(await cache.getOrSet(entry(key, load))).toEqual({ name: 'shared' })
    })
  })

  describe('an entry written when the generations of its scopes could not be read', () => {
    it('is a miss for a read that has scopes, instead of looking current', async () => {
      const scope = newScope()
      const key = newKey()
      // What store() leaves when the read of the generations failed: an entry with none
      await redis.set(`cache:v1:${key}`, JSON.stringify({ g: [], v: { name: 'old' } }), 'EX', 60)
      const load = jest.fn(() => Promise.resolve({ name: 'fresh' }))

      const value = await cache.getOrSet(entry(key, load, { scopes: [scope] }))

      expect(value).toEqual({ name: 'fresh' })
      expect(load).toHaveBeenCalledTimes(1)
    })

    it('is a miss when it has more generations than the read has scopes, and the other way round', async () => {
      const [one, two] = [newScope(), newScope()]
      const key = newKey()
      await redis.set(
        `cache:v1:${key}`,
        JSON.stringify({ g: [0, 0], v: { name: 'two' } }),
        'EX',
        60
      )
      const load = jest.fn(() => Promise.resolve({ name: 'fresh' }))

      await cache.getOrSet(entry(key, load, { scopes: [one] })) // Written for two scopes, read with one
      await cache.getOrSet(entry(key, load, { scopes: [one, two] })) // Now it holds one: read with two

      expect(load).toHaveBeenCalledTimes(2)
    })
  })

  describe('a burst of reads', () => {
    it('loads once for the requests of one process that ask for the same key together', async () => {
      const key = newKey()
      const load = jest.fn(async () => {
        await sleep(100)
        return { name: 'a' }
      })

      const results = await Promise.all(
        Array.from({ length: 20 }, () => cache.getOrSet(entry(key, load)))
      )

      expect(load).toHaveBeenCalledTimes(1)
      expect(results.every(result => result?.name === 'a')).toBe(true)
    })

    it('does not mix the keys of two users that ask together', async () => {
      const [a, b] = [newKey(), newKey()]

      const [first, second] = await Promise.all([
        cache.getOrSet(entry(a, () => Promise.resolve({ name: 'user-a' }))),
        cache.getOrSet(entry(b, () => Promise.resolve({ name: 'user-b' })))
      ])

      expect([first?.name, second?.name]).toEqual(['user-a', 'user-b'])
    })
  })

  describe('when the loader fails', () => {
    it('passes the error on and stores nothing, so the next read tries again', async () => {
      const key = newKey()
      const load = jest
        .fn<Promise<Value>, []>()
        .mockRejectedValueOnce(new Error('database down'))
        .mockResolvedValue({ name: 'back' })

      await expect(cache.getOrSet(entry(key, load))).rejects.toThrow('database down')
      const value = await cache.getOrSet(entry(key, load))

      expect(value).toEqual({ name: 'back' })
      expect(load).toHaveBeenCalledTimes(2)
    })

    it('does not cache a value its own schema rejects, and still returns it', async () => {
      const key = newKey()
      const load = jest.fn(() => Promise.resolve({ name: 5 } as unknown as Value))

      const first = await cache.getOrSet(entry(key, load))
      await cache.getOrSet(entry(key, load))

      expect(first).toEqual({ name: 5 })
      expect(load).toHaveBeenCalledTimes(2) // Never stored
      expect(await redis.exists(`cache:v1:${key}`)).toBe(0)
    })
  })

  describe('when Redis fails', () => {
    // A client that cannot reach anything and does not queue commands: every call fails at once
    function brokenRedis(): Redis {
      const client = new Redis({
        host: '127.0.0.1',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null
      })
      client.on('error', () => undefined)
      return client
    }

    it('loads from the source and returns the value, never an error', async () => {
      const broken = brokenRedis()
      const resilient = new CacheService(broken)
      const load = jest.fn(() => Promise.resolve({ name: 'from the source' }))

      const value = await resilient.getOrSet(entry(newKey(), load))

      expect(value).toEqual({ name: 'from the source' })
      expect(load).toHaveBeenCalledTimes(1)
      broken.disconnect()
    })

    it('still passes the error of the loader on', async () => {
      const broken = brokenRedis()
      const resilient = new CacheService(broken)

      await expect(
        resilient.getOrSet(entry(newKey(), () => Promise.reject(new Error('source down'))))
      ).rejects.toThrow('source down')
      broken.disconnect()
    })

    it('fails an invalidation loudly: a revoked permission must not stay cached unnoticed', async () => {
      const broken = brokenRedis()
      const resilient = new CacheService(broken)

      await expect(resilient.del(newKey())).rejects.toThrow()
      await expect(resilient.invalidateScope(newScope())).rejects.toThrow()
      broken.disconnect()
    })
  })

  describe('invalidation', () => {
    it('drops the entries asked for, and only those', async () => {
      const [a, b] = [newKey(), newKey()]
      const loadA = jest.fn(() => Promise.resolve({ name: 'a' }))
      const loadB = jest.fn(() => Promise.resolve({ name: 'b' }))
      await cache.getOrSet(entry(a, loadA))
      await cache.getOrSet(entry(b, loadB))

      await cache.del(a)
      await cache.getOrSet(entry(a, loadA))
      await cache.getOrSet(entry(b, loadB))

      expect(loadA).toHaveBeenCalledTimes(2)
      expect(loadB).toHaveBeenCalledTimes(1)
    })

    it('accepts no keys, and keys that were never cached', async () => {
      await expect(cache.del()).resolves.toBeUndefined()
      await expect(cache.del(newKey())).resolves.toBeUndefined()
    })

    it('makes every entry of a scope a miss, and leaves the other scopes alone', async () => {
      const scope = newScope()
      const other = newScope()
      const [a, b, c] = [newKey(), newKey(), newKey()]
      const loads = [a, b, c].map(() => jest.fn(() => Promise.resolve({ name: 'x' })))
      const scopes = [scope, scope, other]
      for (const [index, key] of [a, b, c].entries()) {
        await cache.getOrSet(
          entry(key, loads[index] as () => Promise<Value>, { scopes: [scopes[index] as string] })
        )
      }

      await cache.invalidateScope(scope)
      for (const [index, key] of [a, b, c].entries()) {
        await cache.getOrSet(
          entry(key, loads[index] as () => Promise<Value>, { scopes: [scopes[index] as string] })
        )
      }

      expect(loads.map(load => load.mock.calls.length)).toEqual([2, 2, 1])
    })

    it('does not serve a value that was loaded while its scope was invalidated', async () => {
      const scope = newScope()
      const key = newKey()
      const load = jest.fn(async () => {
        await cache.invalidateScope(scope) // A role changes while this read is loading
        return { name: 'loaded before the change' }
      })

      await cache.getOrSet(entry(key, load, { scopes: [scope] }))
      await cache.getOrSet(entry(key, load, { scopes: [scope] }))

      expect(load).toHaveBeenCalledTimes(2)
    })

    it('drops an entry when any one of its scopes is invalidated, and not the other entries of the other scope', async () => {
      const [store, member, otherMember] = [newScope(), newScope(), newScope()]
      const [mine, theirs] = [newKey(), newKey()]
      const loadMine = jest.fn(() => Promise.resolve({ name: 'mine' }))
      const loadTheirs = jest.fn(() => Promise.resolve({ name: 'theirs' }))
      await cache.getOrSet(entry(mine, loadMine, { scopes: [store, member] }))
      await cache.getOrSet(entry(theirs, loadTheirs, { scopes: [store, otherMember] }))

      await cache.invalidateScope(member) // One member, not the whole store
      await cache.getOrSet(entry(mine, loadMine, { scopes: [store, member] }))
      await cache.getOrSet(entry(theirs, loadTheirs, { scopes: [store, otherMember] }))
      expect([loadMine.mock.calls.length, loadTheirs.mock.calls.length]).toEqual([2, 1])

      await cache.invalidateScope(store) // The whole store
      await cache.getOrSet(entry(mine, loadMine, { scopes: [store, member] }))
      await cache.getOrSet(entry(theirs, loadTheirs, { scopes: [store, otherMember] }))
      expect([loadMine.mock.calls.length, loadTheirs.mock.calls.length]).toEqual([3, 2])
    })

    it('does not serve a value that was loaded while any of its scopes was invalidated', async () => {
      const [store, member] = [newScope(), newScope()]
      const key = newKey()
      const load = jest.fn(async () => {
        await cache.invalidateScope(member) // This member is removed while the read is loading
        return { name: 'loaded before the removal' }
      })

      await cache.getOrSet(entry(key, load, { scopes: [store, member] }))
      await cache.getOrSet(entry(key, load, { scopes: [store, member] }))

      expect(load).toHaveBeenCalledTimes(2)
    })

    it('keeps the generation of a scope for longer than the longest entry lives', async () => {
      const scope = newScope()
      await cache.invalidateScope(scope)

      const ttl = await redis.ttl(`cache:v1:gen:${scope}`)

      expect(ttl).toBeGreaterThan(86_400) // The longest TTL of the platform is a day
      created.push(`gen:${scope}`)
    })
  })
})
