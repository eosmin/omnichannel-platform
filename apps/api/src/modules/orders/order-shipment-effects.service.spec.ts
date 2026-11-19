import { AsyncLocalStorage } from 'node:async_hooks'

import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import { type EventContext, JobContextGoneError } from '@platform/core/database'

import { OrderShipmentEffects } from './order-shipment-effects.service'
import type { OrderInventoryService } from './orders-inventory.service'

const STORE = 'store-1'
const SHIPMENT = 'shipment-1'
const ACTOR = { type: 'system', id: null } as never

// Row security, in miniature: a query answers only inside a context of the store it names, and a context holds one transaction
function build(options: { goneStore?: boolean } = {}) {
  const open = new AsyncLocalStorage<string>()
  const contexts: string[] = []
  const queriedInside: boolean[] = []
  const events = {
    inStore: (storeId: string, work: () => Promise<unknown>) => {
      if (options.goneStore === true) return Promise.reject(new JobContextGoneError('gone'))
      contexts.push(storeId)
      return open.run(storeId, work)
    }
  }
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    $queryRaw: () => Promise.resolve([{ id: STORE }]),
    shipment: {
      findFirst: () => {
        queriedInside.push(open.getStore() === STORE)
        return Promise.resolve(null)
      },
      findFirstOrThrow: () => {
        queriedInside.push(open.getStore() === STORE)
        return Promise.resolve({
          orderId: 'o1',
          connectionId: null,
          order: { orderNumber: '1001' }
        })
      }
    }
  }
  const published: string[] = []
  const prisma = {
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)
  }
  const domainEvents = { publish: (_tx: unknown, name: string) => published.push(name) }
  const warnings: unknown[][] = []
  const logger = {
    setContext: () => undefined,
    error: () => undefined,
    warn: (...args: unknown[]) => warnings.push(args)
  }
  const effects = new OrderShipmentEffects(
    prisma as never,
    events as unknown as EventContext,
    { log: () => undefined } as unknown as AuditService,
    domainEvents as never,
    {} as OrderInventoryService,
    logger as unknown as PinoLogger
  )
  return { effects, contexts, queriedInside, published, warnings }
}

describe('OrderShipmentEffects under row security', () => {
  it('reads the shipment inside the context of the store of the event', async () => {
    const { effects, contexts, queriedInside } = build()
    await effects.follow(STORE, SHIPMENT, ACTOR, false)
    expect(contexts).toEqual([STORE])
    expect(queriedInside).toEqual([true])
  })

  it('does nothing, and does not fail, for a store that no longer exists', async () => {
    const { effects, queriedInside, warnings } = build({ goneStore: true })
    await expect(effects.follow(STORE, SHIPMENT, ACTOR, false)).resolves.toMatchObject({
      shipped: false,
      delivered: false
    })
    expect(queriedInside).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('raises the review notice of a failed follow inside the context too', async () => {
    const { effects, contexts, queriedInside, published } = build()
    await effects.reportFailure(STORE, SHIPMENT, ACTOR, new Error('lock timeout'))
    expect(contexts).toEqual([STORE])
    expect(queriedInside).toEqual([true])
    expect(published).toHaveLength(1)
  })
})
