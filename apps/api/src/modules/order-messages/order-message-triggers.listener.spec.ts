import type { PinoLogger } from 'nestjs-pino'

import { type EventContext, JobContextGoneError } from '@platform/core/database'
import { OrderStatus } from '@platform/core/domain'

import { OrderMessageListener } from './order-message-triggers.listener'

// The service pulls the env of the platform with it: the listener only needs its name
jest.mock('./order-messages.service', () => ({ OrderMessagesService: class {} }))

const STORE = 'store-1'

describe('OrderMessageListener when the store is gone', () => {
  it('neither asks again nor alerts the team', async () => {
    const calls = { send: 0, alert: 0 }
    const messages = {
      send: () => {
        calls.send += 1
        return Promise.reject(new JobContextGoneError('gone'))
      },
      alertNotSent: () => {
        calls.alert += 1
        return Promise.resolve()
      }
    }
    const events = { inStore: (_id: string, work: () => Promise<unknown>) => work() }
    const logger = { setContext: () => undefined, warn: () => undefined, error: () => undefined }
    const listener = new OrderMessageListener(
      {} as never,
      events as unknown as EventContext,
      messages as never,
      logger as unknown as PinoLogger
    )
    await listener.onOrderStatusChanged({
      storeId: STORE,
      orderId: 'order-1',
      actor: { type: 'user', id: 'user-1' },
      to: OrderStatus.SHIPPED,
      from: OrderStatus.CONFIRMED,
      orderNumber: '1001',
      notifyCustomer: true
    } as never)
    expect(calls).toEqual({ send: 1, alert: 0 })
  })
})
