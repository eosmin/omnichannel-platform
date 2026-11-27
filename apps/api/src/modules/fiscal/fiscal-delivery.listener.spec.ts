import type { PinoLogger } from 'nestjs-pino'

import { FiscalDeliveryListener } from './fiscal-delivery.listener'

// The service pulls the env of the platform with it: the listener only needs its name
jest.mock('./fiscal-delivery.service', () => ({ FiscalDeliveryService: class {} }))

const PAYLOAD = {
  organizationId: 'org-1',
  storeId: 'store-1',
  documentId: 'doc-1',
  orderId: 'order-1'
}
const INPUT = { organizationId: 'org-1', storeId: 'store-1', documentId: 'doc-1' }
const logger = { setContext: () => undefined, warn: () => undefined, error: () => undefined }

function build(deliver: jest.Mock, recordFailure: jest.Mock = jest.fn()) {
  return new FiscalDeliveryListener(
    { inOrganization: (_id: string, work: () => Promise<unknown>) => work() } as never,
    { deliver, recordFailure } as never,
    logger as unknown as PinoLogger
  )
}

describe('FiscalDeliveryListener', () => {
  // Nest reads the constructor types at run time: a type-only import leaves one `undefined` and the api does not start
  it('keeps the type of every constructor parameter for the injector', () => {
    const types = Reflect.getMetadata('design:paramtypes', FiscalDeliveryListener) as unknown[]
    expect(types).toHaveLength(3)
    expect(types.every(type => typeof type === 'function' && type !== Object)).toBe(true)
  })

  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('gives the files of an accepted document once and records nothing else', async () => {
    const deliver = jest.fn().mockResolvedValue('sent')
    const recordFailure = jest.fn()
    await build(deliver, recordFailure).onAccepted(PAYLOAD)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith(INPUT)
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('tries again after a failure and stops at the first try that works', async () => {
    const deliver = jest
      .fn()
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValue('sent')
    const recordFailure = jest.fn()
    const done = build(deliver, recordFailure).onAccepted(PAYLOAD)
    await jest.runAllTimersAsync()
    await done
    expect(deliver).toHaveBeenCalledTimes(2)
    expect(recordFailure).not.toHaveBeenCalled()
  })

  it('records the failure, so the person is told, after the last try', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('queue down'))
    const recordFailure = jest.fn().mockResolvedValue(undefined)
    const done = build(deliver, recordFailure).onAccepted(PAYLOAD)
    await jest.runAllTimersAsync()
    await done
    expect(deliver).toHaveBeenCalledTimes(3)
    expect(recordFailure).toHaveBeenCalledWith(INPUT)
  })

  it('never throws to the document, even when the failure cannot be recorded', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('down'))
    const recordFailure = jest.fn().mockRejectedValue(new Error('database down'))
    const done = build(deliver, recordFailure).onAccepted(PAYLOAD)
    await jest.runAllTimersAsync()
    await expect(done).resolves.toBeUndefined()
  })
})
