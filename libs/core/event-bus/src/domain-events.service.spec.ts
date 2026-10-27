import type { EventEmitter2 } from '@nestjs/event-emitter'
import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
import { Events } from '@platform/core/events'

import { DomainEvents } from './domain-events.service'
import type { EventsBridge } from './events-bridge'

const payload = { storeId: 's', customerId: 'c' }

function build(emitAsync: jest.Mock) {
  // A transaction that commits when `commit` is called, as PrismaService.afterCommit promises
  const hooks: Array<() => void> = []
  const prisma = {
    afterCommit: (_tx: unknown, hook: () => void) => hooks.push(hook)
  } as unknown as PrismaService
  const logger = { setContext: jest.fn(), error: jest.fn() }
  const bridge = { publish: jest.fn() }
  const events = new DomainEvents(
    prisma,
    { emitAsync } as unknown as EventEmitter2,
    logger as unknown as PinoLogger,
    bridge as unknown as EventsBridge
  )
  return { events, logger, bridge, commit: () => hooks.forEach(hook => hook()) }
}

describe('DomainEvents', () => {
  it('emits nothing until the transaction commits, then emits the event with its payload', () => {
    const emit = jest.fn(() => Promise.resolve([]))
    const { events, commit } = build(emit)

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)
    expect(emit).not.toHaveBeenCalled()
    commit()

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(Events.CUSTOMER_CREATED, payload)
  })

  it('logs a listener that throws and does not let it fail the caller', () => {
    const failure = new Error('listener failed')
    const { events, logger, commit } = build(
      jest.fn(() => {
        throw failure
      })
    )

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)

    expect(commit).not.toThrow()
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, event: Events.CUSTOMER_CREATED },
      expect.any(String)
    )
  })

  it('logs a listener whose promise rejects', async () => {
    const failure = new Error('async listener failed')
    const { events, logger, commit } = build(jest.fn(() => Promise.reject(failure)))

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)
    commit()
    await new Promise(resolve => setImmediate(resolve))

    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, event: Events.CUSTOMER_CREATED },
      expect.any(String)
    )
  })

  it('hands the event to the bridge after the commit', () => {
    const { events, bridge, commit } = build(jest.fn(() => Promise.resolve([])))

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)
    expect(bridge.publish).not.toHaveBeenCalled()
    commit()

    expect(bridge.publish).toHaveBeenCalledWith(Events.CUSTOMER_CREATED, payload)
  })

  it('hands the event to the bridge even when a listener fails', () => {
    const { events, bridge, commit } = build(
      jest.fn(() => {
        throw new Error('listener failed')
      })
    )

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)
    commit()

    expect(bridge.publish).toHaveBeenCalledWith(Events.CUSTOMER_CREATED, payload)
  })

  it('hands the event to the bridge even when a listener rejects', async () => {
    const { events, bridge, commit } = build(jest.fn(() => Promise.reject(new Error('rejected'))))

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)
    commit()
    await new Promise(resolve => setImmediate(resolve))

    expect(bridge.publish).toHaveBeenCalledWith(Events.CUSTOMER_CREATED, payload)
  })

  it('logs a bridge that throws and does not let it escape the commit', () => {
    const emit = jest.fn(() => Promise.resolve([]))
    const { events, bridge, logger, commit } = build(emit)
    const failure = new Error('redis is down')
    bridge.publish.mockImplementation(() => {
      throw failure
    })

    events.publish({} as PrismaService['client'], Events.CUSTOMER_CREATED, payload)

    expect(commit).not.toThrow()
    expect(emit).toHaveBeenCalledWith(Events.CUSTOMER_CREATED, payload)
    expect(logger.error).toHaveBeenCalledWith(
      { err: failure, event: Events.CUSTOMER_CREATED },
      expect.any(String)
    )
  })
})
