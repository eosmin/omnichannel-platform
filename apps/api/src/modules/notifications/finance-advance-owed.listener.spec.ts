import { FinancePostingKey, OrderStatus } from '@platform/core/domain'
import type { OrderStatusChangedPayload } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsEventsListener } from './notifications-events.listener'

const ORG = 'org-1'
const STORE = 'store-1'
const ORDER = 'order-1'

const payload = (to: OrderStatus): OrderStatusChangedPayload => ({
  storeId: STORE,
  orderId: ORDER,
  orderNumber: '1001',
  actor: { type: 'user', id: 'user-1' },
  from: OrderStatus.CONFIRMED,
  to
})

function build(options: { booked?: boolean; known?: boolean; fails?: boolean } = {}) {
  const sent: { users: readonly string[]; input: Record<string, unknown> }[] = []
  const looked: unknown[] = []
  const prisma = {
    client: {
      order: {
        findFirst: () =>
          Promise.resolve(options.known === false ? null : { store: { organizationId: ORG } })
      },
      journalEntry: {
        findUnique: (args: unknown) => {
          looked.push(args)
          return options.fails === true
            ? Promise.reject(new Error('down'))
            : Promise.resolve(options.booked === false ? null : { id: 'e1' })
        }
      },
      membership: {
        findMany: () => Promise.resolve([{ userId: 'u1' }, { userId: 'u2' }])
      }
    }
  }
  const notifications = {
    sendToUsersOnce: (users: readonly string[], input: Record<string, unknown>) => {
      sent.push({ users, input })
      return Promise.resolve()
    }
  }
  const listener = new NotificationsEventsListener(
    prisma as never,
    notifications as never,
    {} as never,
    { inc: () => undefined } as never
  )
  return { listener, sent, looked }
}

describe('the notice of a cancelled order that has an advance (HC-105)', () => {
  it('tells who may move money in the store, once, when the payment of the order was booked', async () => {
    const { listener, sent, looked } = build()
    await listener.onPaidOrderCancelled(payload(OrderStatus.CANCELLED))
    expect(JSON.stringify(looked[0])).toContain(FinancePostingKey.ORDER_PAYMENT(ORDER))
    expect(JSON.stringify(looked[0])).toContain(ORG)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.input).toMatchObject({
      storeId: STORE,
      type: NotificationTypes.FINANCE_ADVANCE_OWED,
      params: { orderNumber: '1001' },
      resourceId: ORDER
    })
  })

  it('tells nobody when the payment was never booked, for another status, or for an unknown order', async () => {
    const unbooked = build({ booked: false })
    await unbooked.listener.onPaidOrderCancelled(payload(OrderStatus.CANCELLED))
    expect(unbooked.sent).toEqual([])
    const other = build()
    await other.listener.onPaidOrderCancelled(payload(OrderStatus.SHIPPED))
    expect(other.sent).toEqual([])
    const unknown = build({ known: false })
    await unknown.listener.onPaidOrderCancelled(payload(OrderStatus.CANCELLED))
    expect(unknown.sent).toEqual([])
  })

  it('never throws to the bus', async () => {
    const broken = build({ fails: true })
    await expect(
      broken.listener.onPaidOrderCancelled(payload(OrderStatus.CANCELLED))
    ).resolves.toBeUndefined()
  })
})
