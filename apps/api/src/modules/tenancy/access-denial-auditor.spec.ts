import type { Redis } from 'ioredis'
import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { AccessDenialAuditor, type Denial } from './access-denial-auditor'

const request = {
  method: 'GET',
  ip: '203.0.113.9',
  route: { path: '/api/v1/things/:id' },
  get: (name: string) => (name === 'user-agent' ? 'Firefox' : undefined)
} as unknown as AuthenticatedRequest

const denial: Denial = {
  action: 'tenant.access_denied',
  userId: 'user-1',
  request,
  metadata: { requestedStoreId: 'store-1' }
}

// The budget is one MULTI: INCR and EXPIRE NX together, so that a crash cannot leave a counter with no end
function redisCounting(counts: number[] | ((n: number) => number)): {
  redis: Redis
  multi: jest.Mock
  incr: jest.Mock
  expire: jest.Mock
} {
  let calls = 0
  const incr = jest.fn().mockReturnThis()
  const expire = jest.fn().mockReturnThis()
  const exec = jest.fn(() => {
    calls += 1
    const count = typeof counts === 'function' ? counts(calls) : (counts[calls - 1] ?? calls)
    return Promise.resolve([
      [null, count],
      [null, 1]
    ])
  })
  const chain = { incr, expire, exec }
  const multi = jest.fn(() => chain)
  return { redis: { multi } as unknown as Redis, multi, incr, expire }
}

function build(redis: Redis) {
  const log = jest.fn<void, [Record<string, unknown>]>()
  const warn = jest.fn()
  const auditor = new AccessDenialAuditor({ log } as unknown as AuditService, redis, {
    setContext: jest.fn(),
    warn
  } as unknown as PinoLogger)
  return { auditor, log, warn }
}

describe('AccessDenialAuditor', () => {
  it('writes the refusal with who, where from and the route pattern, never the real URL', async () => {
    const { auditor, log } = build(redisCounting([1]).redis)

    await auditor.record({ ...denial, storeId: 'store-9' })

    expect(log).toHaveBeenCalledWith({
      action: 'tenant.access_denied',
      actor: { userId: 'user-1' },
      storeId: 'store-9',
      metadata: { method: 'GET', path: '/api/v1/things/:id', requestedStoreId: 'store-1' },
      ipAddress: '203.0.113.9',
      userAgent: 'Firefox'
    })
  })

  it('gives the minute its end in the same step as the count, on every refusal', async () => {
    const { redis, multi, incr, expire } = redisCounting(n => n)
    const { auditor } = build(redis)

    await auditor.record(denial)
    await auditor.record(denial)

    expect(multi).toHaveBeenCalledTimes(2)
    expect(incr).toHaveBeenCalledWith(expect.stringContaining('user-1'))
    // NX: only a counter that has no end gets one, so the minute does not slide
    expect(expire).toHaveBeenCalledWith(expect.stringContaining('user-1'), 60, 'NX')
  })

  it('keeps ten refusals a minute, says once that it stopped, and writes no more', async () => {
    const { redis } = redisCounting(n => n)
    const { auditor, log, warn } = build(redis)

    for (let i = 0; i < 14; i += 1) await auditor.record(denial)

    expect(log).toHaveBeenCalledTimes(10)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('writes the refusal anyway when Redis cannot say how many there were', async () => {
    const failing = {
      multi: () => ({
        incr: () => ({ expire: () => ({ exec: () => Promise.reject(new Error('redis down')) }) })
      })
    }
    const { auditor, log } = build(failing as unknown as Redis)

    await expect(auditor.record(denial)).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledTimes(1) // A duplicate trace is better than none
  })

  it.each([
    ['a transaction that Redis discarded', null],
    ['an empty answer', []],
    ['a count that came back as an error', [[new Error('WRONGTYPE'), null]]],
    ['a count that is not a number', [[null, 'many']]]
  ])('writes the refusal anyway after %s', async (_name, answer) => {
    const exec = () => Promise.resolve(answer)
    const redis = { multi: () => ({ incr: () => ({ expire: () => ({ exec }) }) }) }
    const { auditor, log } = build(redis as unknown as Redis)

    await auditor.record(denial)

    expect(log).toHaveBeenCalledTimes(1)
  })

  it('leaves out the optional fields the request does not have', async () => {
    const bare = { method: 'GET', get: () => undefined } as unknown as AuthenticatedRequest
    const { auditor, log } = build(redisCounting([1]).redis)

    await auditor.record({ ...denial, request: bare })

    const entry = log.mock.calls[0]?.[0] ?? {}
    expect(entry).not.toHaveProperty('storeId')
    expect(entry).not.toHaveProperty('ipAddress')
    expect(entry).not.toHaveProperty('userAgent')
  })
})
