import type { Redis } from 'ioredis'

import { PresenceStatus } from '@platform/core/realtime'

import { PresenceService } from './presence.service'
import type { RealtimeService } from './realtime.service'

// A Redis whose pipeline answers each command with the given [error, value] pairs
function fakeRedis(
  replies: [Error | null, unknown][],
  members = ['user-1']
): { redis: Redis; evaluated: () => number; forgotten: () => unknown[] } {
  let evaluations = 0
  const forgotten: unknown[] = []
  const pipeline = {
    zcount: () => pipeline,
    get: () => pipeline,
    eval: (...args: unknown[]) => {
      evaluations += 1
      forgotten.push(args[4])
      return pipeline
    },
    exec: () => Promise.resolve(replies)
  }
  const redis = {
    smembers: () => Promise.resolve(members),
    pipeline: () => pipeline
  } as unknown as Redis // test double of the client
  return { redis, evaluated: () => evaluations, forgotten: () => forgotten }
}

describe('PresenceService.getStorePresence', () => {
  it('fails when Redis refuses a command, instead of reporting the team as offline', async () => {
    const { redis, evaluated } = fakeRedis([
      [new Error('LOADING'), null],
      [new Error('LOADING'), null]
    ])
    const presence = new PresenceService(redis, {} as RealtimeService) // the sockets are not what is tested

    await expect(presence.getStorePresence('store-1')).rejects.toThrow('LOADING')
    expect(evaluated()).toBe(0)
  })

  it('reports a user with a live socket as online', async () => {
    const { redis } = fakeRedis([
      [null, 1],
      [null, String(Date.now())]
    ])
    const presence = new PresenceService(redis, {} as RealtimeService) // the sockets are not what is tested

    await expect(presence.getStorePresence('store-1')).resolves.toEqual([
      { userId: 'user-1', status: PresenceStatus.ONLINE }
    ])
  })

  it('reports who is connected and forgets who has no live socket left', async () => {
    const { redis, evaluated, forgotten } = fakeRedis(
      [
        [null, 1],
        [null, String(Date.now())],
        [null, 0],
        [null, null]
      ],
      ['user-1', 'user-2']
    )
    const presence = new PresenceService(redis, {} as RealtimeService) // the sockets are not what is tested

    await expect(presence.getStorePresence('store-1')).resolves.toEqual([
      { userId: 'user-1', status: PresenceStatus.ONLINE }
    ])
    expect(evaluated()).toBe(1)
    expect(forgotten()).toEqual(['user-2'])
  })
})
