import { Permissions } from '@platform/core/auth'
import { FinancePostingKey } from '@platform/core/domain'
import type { OrderEventPayload } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'

import { NotificationsEventsListener } from './notifications-events.listener'

const ORG = 'org-1'
const STORE = 'store-1'
const ORDER = 'order-1'

const payload: OrderEventPayload = {
  storeId: STORE,
  orderId: ORDER,
  orderNumber: '1001',
  actor: { type: 'user', id: 'user-1' }
}

function build(
  options: { booked?: boolean; known?: boolean; fails?: boolean; paymentStatus?: string } = {}
) {
  const sent: { users: readonly string[]; input: Record<string, unknown> }[] = []
  const entryQueries: unknown[] = []
  const orderQueries: unknown[] = []
  const memberQueries: unknown[] = []
  const prisma = {
    client: {
      order: {
        findFirst: (args: unknown) => {
          orderQueries.push(args)
          return Promise.resolve(
            options.known === false
              ? null
              : {
                  paymentStatus: options.paymentStatus ?? 'COMPLETED',
                  store: { organizationId: ORG }
                }
          )
        }
      },
      journalEntry: {
        findUnique: (args: unknown) => {
          entryQueries.push(args)
          return options.fails === true
            ? Promise.reject(new Error('down'))
            : Promise.resolve(options.booked === false ? null : { id: 'e1' })
        }
      },
      membership: {
        findMany: (args: unknown) => {
          memberQueries.push(args)
          return Promise.resolve([{ userId: 'u1' }, { userId: 'u2' }])
        }
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
  return { listener, sent, entryQueries, orderQueries, memberQueries }
}

describe('the notice of a cancelled order that has an advance (HC-105)', () => {
  it('tells who may move money in the store, once, when the payment of the order was booked', async () => {
    const { listener, sent, entryQueries, orderQueries, memberQueries } = build()
    await listener.onPaidOrderCancelled(payload)
    // The order is looked up inside its own store, and the entry inside its organization
    expect(JSON.stringify(orderQueries[0])).toContain(STORE)
    expect(JSON.stringify(entryQueries[0])).toContain(ORG)
    expect(JSON.stringify(entryQueries[0])).toContain(FinancePostingKey.ORDER_PAYMENT(ORDER))
    // Recipients: members of that store who hold a money permission and may read finance, not necessarily the orders
    const asked = JSON.stringify(memberQueries[0])
    expect(asked).toContain(STORE)
    expect(asked).toContain(Permissions.FINANCE_MOVE_MONEY)
    expect(asked).toContain(Permissions.FINANCE_POST_MANUAL)
    expect(asked).toContain(Permissions.FINANCE_VIEW)
    expect(asked).not.toContain(Permissions.ORDERS_VIEW)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.users).toEqual(['u1', 'u2'])
    expect(sent[0]?.input).toMatchObject({
      storeId: STORE,
      type: NotificationTypes.FINANCE_ADVANCE_OWED,
      params: { orderNumber: '1001' },
      resourceId: `advance:${ORDER}`
    })
    expect(sent[0]?.input).not.toHaveProperty('actionPath')
  })

  it('tells nobody when the payment was never booked, already went back, or the order is unknown', async () => {
    const unbooked = build({ booked: false })
    await unbooked.listener.onPaidOrderCancelled(payload)
    expect(unbooked.sent).toEqual([])
    const refunded = build({ paymentStatus: 'REFUNDED' })
    await refunded.listener.onPaidOrderCancelled(payload)
    expect(refunded.sent).toEqual([])
    expect(refunded.entryQueries).toEqual([])
    const unknown = build({ known: false })
    await unknown.listener.onPaidOrderCancelled(payload)
    expect(unknown.sent).toEqual([])
  })

  it('never throws to the bus', async () => {
    const broken = build({ fails: true })
    await expect(broken.listener.onPaidOrderCancelled(payload)).resolves.toBeUndefined()
  })
})
