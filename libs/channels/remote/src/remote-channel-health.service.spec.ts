import type { PinoLogger } from 'nestjs-pino'

import type { ChannelHealthService, CheckedHealth } from '@platform/channels/connection-health'
import { CacheKeys } from '@platform/core/cache'
import type { JobContext, PrismaService, WorkerLists } from '@platform/core/database'
import { PluginRegistry } from '@platform/plugins/runtime'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { RemoteChannelHealthService } from './remote-channel-health.service'

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
} as unknown as PinoLogger

const row = (id: string, pluginId = 'acme_chat') => ({
  id,
  storeId: 'store-1',
  pluginId,
  connectionId: `acct-${id}`,
  status: 'active',
  credentials: new Uint8Array(),
  metadata: {}
})

function setup(rows: ReturnType<typeof row>[], verdicts: Record<string, CheckedHealth[]>) {
  const counts = new Map<string, number>()
  const redis = {
    incr: jest.fn((key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return Promise.resolve(counts.get(key))
    }),
    expire: jest.fn<Promise<number>, [string, number]>(() => Promise.resolve(1)),
    multi: jest.fn(() => {
      const steps: (() => Promise<unknown>)[] = []
      const chain = {
        incr: (key: string) => {
          steps.push(() => redis.incr(key))
          return chain
        },
        expire: (key: string, seconds: number) => {
          steps.push(() => redis.expire(key, seconds))
          return chain
        },
        exec: async () => {
          const out: [null, unknown][] = []
          for (const step of steps) out.push([null, await step()])
          return out
        }
      }
      return chain
    }),
    del: jest.fn((key: string) => {
      counts.delete(key)
      return Promise.resolve(1)
    })
  }
  const prisma = {
    client: {
      channelConnection: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve(rows.find(r => r.id === where.id) ?? null)
        )
      }
    }
  } as unknown as PrismaService
  // The list of the database, and a context that just runs the work
  const lists = {
    activeChannelConnections: jest.fn(() =>
      Promise.resolve(
        rows.map(r => ({
          id: r.id,
          storeId: 'store-1',
          pluginId: r.pluginId,
          updatedAt: new Date(0)
        }))
      )
    )
  } as unknown as WorkerLists
  const jobContext = {
    forStore: jest.fn((_storeId: string, work: () => Promise<unknown>) => work())
  } as unknown as JobContext
  const recorded: { id: string; healthy: boolean }[] = []
  const check = jest.fn((r: { id: string }) => {
    const next = verdicts[r.id]?.shift()
    return Promise.resolve(next ?? { healthy: true })
  })
  const health = {
    check,
    record: jest.fn((r: { id: string }, h: CheckedHealth) => {
      recorded.push({ id: r.id, healthy: h.healthy })
      return Promise.resolve()
    })
  } as unknown as ChannelHealthService
  const registry = new PluginRegistry(logger)
  jest.spyOn(registry, 'isRemote').mockImplementation(id => id === 'acme_chat')
  jest
    .spyOn(registry, 'find')
    .mockImplementation(id => (id === 'acme_chat' ? ({ id } as ChannelPlugin) : undefined))
  const service = new RemoteChannelHealthService(
    prisma,
    health,
    registry,
    redis as unknown as ConstructorParameters<typeof RemoteChannelHealthService>[3],
    logger,
    jobContext,
    lists
  )
  return { service, redis, recorded, counts, check }
}

const bad: CheckedHealth = { healthy: false, error: 'session expired' }

describe('RemoteChannelHealthService', () => {
  it('counts the failures and puts the connection in error only at the third in a row', async () => {
    const { service, recorded, redis } = setup([row('c1')], { c1: [bad, bad, bad, bad] })
    await service.checkAll()
    await service.checkAll()
    expect(recorded).toEqual([])
    const third = await service.checkAll()
    expect(third).toEqual({ checked: 1, unhealthy: 1 })
    expect(recorded).toEqual([{ id: 'c1', healthy: false }])
    // Still failing: the verdict is kept up to date
    await service.checkAll()
    expect(recorded).toHaveLength(2)
    expect(redis.expire).toHaveBeenCalledWith(CacheKeys.channel.healthFailures('c1'), 3600)
  })

  it('a healthy check clears the count and brings the connection back', async () => {
    const { service, recorded, counts } = setup([row('c1')], {
      c1: [bad, bad, { healthy: true }, bad]
    })
    await service.checkAll()
    await service.checkAll()
    expect(counts.get(CacheKeys.channel.healthFailures('c1'))).toBe(2)
    await service.checkAll()
    expect(counts.has(CacheKeys.channel.healthFailures('c1'))).toBe(false)
    expect(recorded).toEqual([{ id: 'c1', healthy: true }])
    // The count starts over: one failure after a healthy one is not three
    await service.checkAll()
    expect(recorded).toEqual([{ id: 'c1', healthy: true }])
  })

  it('keeps the count of each connection apart', async () => {
    const { service, recorded } = setup([row('c1'), row('c2')], {
      c1: [bad, bad, bad],
      c2: [bad, { healthy: true }, bad]
    })
    await service.checkAll()
    await service.checkAll()
    await service.checkAll()
    expect(recorded.filter(r => r.id === 'c1' && !r.healthy)).toHaveLength(1)
    expect(recorded.some(r => r.id === 'c2' && !r.healthy)).toBe(false)
  })

  it('leaves the connections of the official plugins to their own round', async () => {
    const { service, check } = setup([row('c1', 'official_chat')], {})
    await expect(service.checkAll()).resolves.toEqual({ checked: 0, unhealthy: 0 })
    expect(check).not.toHaveBeenCalled()
  })

  it('changes nothing when Redis is down, and goes on with the next connection', async () => {
    const { service, recorded, redis } = setup([row('c1'), row('c2')], {
      c1: [bad],
      c2: [{ healthy: true }]
    })
    redis.incr.mockRejectedValueOnce(new Error('redis down'))
    const result = await service.checkAll()
    expect(recorded).toEqual([{ id: 'c2', healthy: true }])
    expect(result.checked).toBe(2)
  })

  it('stops starting checks when the budget is spent', async () => {
    const { service, check } = setup([row('c1'), row('c2')], {})
    await service.checkAll(-1)
    expect(check).not.toHaveBeenCalled()
  })
})
