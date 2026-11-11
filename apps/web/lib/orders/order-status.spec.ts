import { OrderStatus } from '@platform/core/domain'

import { orderStatusKey } from './order-status'

describe('orderStatusKey', () => {
  it('returns a state this page knows', () => {
    expect(orderStatusKey('DELIVERED')).toBe(OrderStatus.DELIVERED)
  })

  it('returns null for a state of a newer server', () => {
    expect(orderStatusKey('TELEPORTED')).toBeNull()
    expect(orderStatusKey('')).toBeNull()
  })
})
