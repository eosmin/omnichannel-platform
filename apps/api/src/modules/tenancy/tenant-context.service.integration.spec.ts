import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'

import { Permissions } from '@platform/core/auth'
import type { PrismaService } from '@platform/core/database'
import { CacheService } from '@platform/core/redis'

import { REDIS_URL } from '../../testing/test-env'

import { TenantContextService } from './tenant-context.service'

// The race that a plain delete of the cache key cannot close: the change is made, and the cache is
// told, while another request is in the middle of reading the old state. Real Redis; the database is
// a double whose answer and timing the test controls.
describe('TenantContextService, when the change arrives while the context is loading', () => {
  // Opened in beforeAll: see cache.service.integration.spec.ts
  let redis: Redis
  let cache: CacheService
  const touched: { userId: string; storeId: string }[] = []
  beforeAll(() => {
    redis = new Redis(REDIS_URL)
    cache = new CacheService(redis)
  })
  afterAll(async () => {
    // The entries die by their TTL, but a generation lives for days: remove what this run made
    const keys = touched.flatMap(({ userId, storeId }) => [
      `cache:v1:perms:${userId}:${storeId}`,
      `cache:v1:gen:tenant:${storeId}`,
      `cache:v1:gen:tenant:${storeId}:${userId}`
    ])
    if (keys.length > 0) await redis.del(...keys)
    await redis.quit()
  })

  function membershipOf(storeId: string): object {
    return {
      id: randomUUID(),
      store: { id: storeId, organizationId: randomUUID(), name: 'Shop' },
      role: { id: randomUUID(), name: 'Admin', permissions: [{ name: Permissions.CUSTOMERS_VIEW }] }
    }
  }

  // A database whose reads of the membership are held back until the test lets them go: the read
  // takes its snapshot of the old state when it starts, as a real query does
  function slowDatabase(initial: object | null) {
    let current: object | null = initial
    let release: () => void = () => undefined
    const reads: Promise<void>[] = []
    const findFirst = jest.fn(async () => {
      const snapshot = current
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      reads.push(gate)
      await gate
      return snapshot
    })
    return {
      prisma: { client: { membership: { findFirst } } } as unknown as PrismaService,
      findFirst,
      change: (next: object | null) => {
        current = next
      },
      release: () => release(),
      // Waits for a read to reach the database, and fails the test if none does: with a cache that
      // answered from an old entry there would be nothing to wait for
      started: async () => {
        const deadline = Date.now() + 2000
        while (findFirst.mock.calls.length === 0) {
          if (Date.now() > deadline) throw new Error('the context was not read from the database')
          await new Promise(resolve => setImmediate(resolve))
        }
      }
    }
  }

  it('does not keep the old context of a member that was removed meanwhile', async () => {
    const [userId, realStoreId] = [randomUUID(), randomUUID()]
    touched.push({ userId, storeId: realStoreId })
    const db = slowDatabase(membershipOf(realStoreId))
    const contexts = new TenantContextService(db.prisma, cache)

    const inFlight = contexts.resolve(userId, realStoreId) // Reads the old state, and waits
    await db.started()
    db.change(null) // The member is removed...
    await contexts.invalidateUser(userId, realStoreId) // ...and the cache is told
    db.release()
    expect(await inFlight).not.toBeNull() // This request began before the removal: it may see the old state

    db.findFirst.mockClear()
    // The next one must not be served the old state the in-flight read just stored
    const next = contexts.resolve(userId, realStoreId)
    await db.started()
    db.release()
    expect(await next).toBeNull()
  })

  it('does not keep the old context of anybody in a store whose role was edited meanwhile', async () => {
    const [userId, storeId] = [randomUUID(), randomUUID()]
    touched.push({ userId, storeId })
    const db = slowDatabase(membershipOf(storeId))
    const contexts = new TenantContextService(db.prisma, cache)

    const inFlight = contexts.resolve(userId, storeId)
    await db.started()
    db.change(null)
    await contexts.invalidateStore(storeId)
    db.release()
    await inFlight

    db.findFirst.mockClear()
    const next = contexts.resolve(userId, storeId)
    await db.started()
    db.release()
    expect(await next).toBeNull()
  })
})
