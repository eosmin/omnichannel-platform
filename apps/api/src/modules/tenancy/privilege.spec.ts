import { Permissions } from '@platform/core/auth'

import { missingPermissions } from './privilege'

describe('missingPermissions', () => {
  const held = [Permissions.TEAM_VIEW, Permissions.TEAM_MANAGE_ROLES]

  it('is empty when the caller holds all that is needed', () => {
    expect(missingPermissions(held, [Permissions.TEAM_VIEW])).toEqual([])
    expect(missingPermissions(held, [])).toEqual([])
  })

  it('lists what the caller lacks, once and in order', () => {
    expect(
      missingPermissions(held, [
        Permissions.ORDERS_VIEW,
        Permissions.TEAM_VIEW,
        Permissions.ORDERS_EDIT
      ])
    ).toEqual([Permissions.ORDERS_VIEW, Permissions.ORDERS_EDIT])
  })

  it('lacks everything when it holds nothing', () => {
    expect(missingPermissions([], [Permissions.TEAM_VIEW])).toEqual([Permissions.TEAM_VIEW])
  })
})
