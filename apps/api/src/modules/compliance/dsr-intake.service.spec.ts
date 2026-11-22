import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

import { type DsrConfig, openDsrIntake } from '@platform/core/compliance'
import { ErrorCodes } from '@platform/core/errors'
import type { DsrIntakeJob } from '@platform/core/queues'

import type { DsrIntakeBody } from './compliance.schemas'
import { DsrIntakeService } from './dsr-intake.service'

// The arguments of a call of a mock, typed by the caller (`mock.calls` is `any` for a bare jest.fn)
const argOf = <T>(mock: jest.Mock, call: number, arg: number): T =>
  (mock.mock.calls as unknown[][])[call]?.[arg] as T

const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}
const body: DsrIntakeBody = {
  storeKey: 'k'.repeat(24),
  type: 'access' as DsrIntakeBody['type'],
  email: 'ana@example.com',
  locale: 'es'
}

function build(config: DsrConfig, counts: number[] = [1, 1]) {
  const eval_ = jest.fn()
  for (const count of counts) eval_.mockResolvedValueOnce(count)
  const add = jest.fn().mockResolvedValue(undefined)
  const redis = { eval: eval_ } as unknown as Redis
  const queue = { add } as unknown as Queue<DsrIntakeJob>
  return { service: new DsrIntakeService(redis, queue, config), eval_, add }
}

describe('DsrIntakeService', () => {
  it('answers the same fixed body when the flow is off, and counts, writes and queues nothing', async () => {
    const off = build({ ...CONFIG, enabled: false })
    const on = build(CONFIG)
    expect(await off.service.submit(body)).toEqual(await on.service.submit(body))
    expect(off.eval_).not.toHaveBeenCalled()
    expect(off.add).not.toHaveBeenCalled()
  })

  it('queues one sealed job with no address in its name, id or data', async () => {
    const { service, add } = build(CONFIG)
    await service.submit(body)
    expect(add).toHaveBeenCalledTimes(1)
    const [name, data, options] = [
      argOf<string>(add, 0, 0),
      argOf<DsrIntakeJob>(add, 0, 1),
      argOf<Record<string, unknown>>(add, 0, 2)
    ] as const
    for (const part of [name, JSON.stringify(data), JSON.stringify(options)]) {
      expect(part).not.toContain('ana@example.com')
      expect(part).not.toContain(body.storeKey)
    }
    expect(options).not.toHaveProperty('jobId')
    expect(openDsrIntake(data.sealed, CONFIG.encryptionKeyHex)).toEqual(body)
  })

  it('counts every request, so the limit answers the same for an address with or without a customer', async () => {
    const { service, eval_ } = build(CONFIG)
    await service.submit(body)
    expect(eval_).toHaveBeenCalledTimes(2)
    const keys = [0, 1].map(call => String(argOf<string>(eval_, call, 2)))
    expect(keys.join()).not.toContain('ana@example.com')
    expect(keys.join()).not.toContain(body.storeKey)
  })

  it.each([
    ['the address', [4, 1]],
    ['the store', [1, 51]]
  ])(
    'refuses with 429 only when the count of %s is over its limit, and queues nothing',
    async (_name, counts) => {
      const { service, add } = build(CONFIG, counts)
      await expect(service.submit(body)).rejects.toMatchObject({
        code: ErrorCodes.RATE_LIMIT_EXCEEDED
      })
      expect(add).not.toHaveBeenCalled()
    }
  )

  it('fails closed when Redis answers nothing usable', async () => {
    const { service, add } = build(CONFIG, ['x' as unknown as number, 1])
    await expect(service.submit(body)).rejects.toMatchObject({
      code: ErrorCodes.RATE_LIMIT_EXCEEDED
    })
    expect(add).not.toHaveBeenCalled()
  })
})
