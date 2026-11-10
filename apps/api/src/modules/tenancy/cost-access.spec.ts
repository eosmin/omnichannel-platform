import { type Permission, Permissions } from '@platform/core/auth'

import { mayViewCost } from './cost-access'

describe('mayViewCost', () => {
  it('is true only for who holds products:view_cost', () => {
    expect(mayViewCost([Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_VIEW_COST])).toBe(true)
    expect(mayViewCost([Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_EDIT])).toBe(false)
    expect(mayViewCost([])).toBe(false)
  })

  it('does not take another permission of the same area for it', () => {
    const others: Permission[] = [
      Permissions.PRODUCTS_VIEW,
      Permissions.PRODUCTS_CREATE,
      Permissions.PRODUCTS_EDIT,
      Permissions.PRODUCTS_DELETE,
      Permissions.INVENTORY_VIEW,
      Permissions.INVENTORY_ADJUST
    ]
    expect(mayViewCost(others)).toBe(false)
  })
})
