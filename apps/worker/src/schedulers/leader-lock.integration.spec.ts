import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'

import { REDIS_URL } from '../testing/test-env'

import { LeaderLockService } from './leader-lock.service'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('LeaderLockService', () => {
  const redis = new Redis(REDIS_URL)
  const name = `it-${randomUUID().slice(0, 8)}`
  const replicaA = new LeaderLockService(redis)
  const replicaB = new LeaderLockService(redis)

  afterAll(async () => {
    await redis.del(CacheKeys.lock(name))
    await redis.quit()
  })

  it('runs a schedule on one replica only while the other is running it', async () => {
    let ranB = false
    const running = replicaA.withLock(name, 30, () => sleep(300))
    await sleep(50)
    const acquiredByB = await replicaB.withLock(name, 30, () => {
      ranB = true
      return Promise.resolve()
    })
    expect(await running).toBe(true)
    expect(acquiredByB).toBe(false)
    expect(ranB).toBe(false)
  })

  it('releases the lock afterwards, so the next tick can run, even if the body throws', async () => {
    await expect(
      replicaA.withLock(name, 30, () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom')
    expect(await redis.exists(CacheKeys.lock(name))).toBe(0)
    expect(await replicaB.withLock(name, 30, () => Promise.resolve())).toBe(true)
  })

  it('does not delete a lock another replica took after this one overran its TTL', async () => {
    let finishB: () => void = () => undefined
    const bHoldsTheLock = new Promise<void>(resolve => {
      finishB = resolve
    })
    let runningB: Promise<boolean> | undefined

    await replicaA.withLock(name, 1, async () => {
      await sleep(1300) // The TTL expires while A is still working
      runningB = replicaB.withLock(name, 30, () => bHoldsTheLock) // B takes the free lock and keeps it
      await sleep(100)
    })

    // A has released by now. A plain DEL would have removed the lock of B; the compare-and-delete
    // sees that the lock is not A's and leaves it
    expect(await redis.exists(CacheKeys.lock(name))).toBe(1)
    finishB()
    expect(await runningB).toBe(true)
    expect(await redis.exists(CacheKeys.lock(name))).toBe(0)
  })
})
