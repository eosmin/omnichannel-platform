import type { ThrottlerStorage } from '@nestjs/throttler'
import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import { JobNames, type RequestMagicLinkJob } from '@platform/core/queues'

import { MagicLinkService } from './magic-link.service'
import type { SessionService } from './session.service'

// What the request does, call by call. The time of an endpoint that tells a known address from an
// unknown one is an oracle for who has an account, so the two must do the same work: this records
// every call to every collaborator and compares the sequences. It never measures milliseconds.
function build() {
  const calls: string[] = []
  const touched = (name: string) => (): never => {
    calls.push(`database:${name}`)
    throw new Error('a request for a link must not touch the database')
  }
  // Any use of the database, in any form, is recorded and fails
  const prisma = new Proxy(
    {},
    {
      get: (_target, property) => touched(String(property)),
      has: () => {
        calls.push('database:has')
        return true
      }
    }
  )
  const storage = {
    increment: jest.fn((key: string) => {
      calls.push('limit')
      void key
      return Promise.resolve({ isBlocked: false, timeToBlockExpire: 0 })
    })
  }
  const queue = {
    add: jest.fn((name: string, data: unknown, options: unknown) => {
      calls.push(`queue:${name}`)
      void data
      void options
      return Promise.resolve()
    })
  }
  const service = new MagicLinkService(
    prisma as never,
    {} as SessionService,
    queue as unknown as Queue<RequestMagicLinkJob>,
    storage as unknown as ThrottlerStorage,
    { setContext: jest.fn(), info: jest.fn() } as unknown as PinoLogger
  )
  return { service, calls, queue, storage }
}

describe('MagicLinkService.request', () => {
  it('does the same operations, in the same order, for any address', async () => {
    const known = build()
    const unknown = build()

    await known.service.request('someone-with-an-account@example.com', 'corr')
    await unknown.service.request('nobody-at-all@example.com', 'corr')

    expect(known.calls).toEqual(['limit', `queue:${JobNames.REQUEST_MAGIC_LINK}`])
    expect(unknown.calls).toEqual(known.calls)
  })

  it('queues the same options and the same shape of payload for any address', async () => {
    const a = build()
    const b = build()

    await a.service.request('a@example.com')
    await b.service.request('  B@Example.com ')

    const [nameA, dataA, optionsA] = a.queue.add.mock.calls[0] ?? []
    const [nameB, dataB, optionsB] = b.queue.add.mock.calls[0] ?? []
    expect(nameA).toBe(JobNames.REQUEST_MAGIC_LINK)
    expect(nameB).toBe(nameA)
    expect(optionsB).toEqual(optionsA)
    expect(dataA).toEqual({ email: 'a@example.com' })
    expect(dataB).toEqual({ email: 'b@example.com' }) // Trimmed and lower-cased before it is counted or queued
  })

  it('counts the limit before it queues anything, so a refused request queues nothing', async () => {
    const refused = build()
    refused.storage.increment.mockResolvedValueOnce({ isBlocked: true, timeToBlockExpire: 30 })

    await expect(refused.service.request('x@example.com')).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED'
    })

    expect(refused.queue.add).not.toHaveBeenCalled()
  })
})
