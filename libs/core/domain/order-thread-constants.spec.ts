import { OrderLineLimits, OrderSummaryEvents } from './order-thread-constants'
import { OrderStatus } from './status-enums'

describe('OrderLineLimits', () => {
  it('holds every event and every state of an order, so the thread never drops a line for its length', () => {
    for (const event of Object.values(OrderSummaryEvents)) {
      expect(event.length).toBeLessThanOrEqual(OrderLineLimits.EVENT_MAX_LENGTH)
    }
    for (const status of Object.values(OrderStatus)) {
      expect(status.length).toBeLessThanOrEqual(OrderLineLimits.STATUS_MAX_LENGTH)
    }
  })
})
