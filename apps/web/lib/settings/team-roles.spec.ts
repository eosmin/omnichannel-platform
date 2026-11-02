import { Permissions } from '@platform/core/auth'

import { canGrant } from './team-roles'

describe('canGrant', () => {
  const holds =
    (...names: string[]) =>
    (permission: string) =>
      names.includes(permission)

  it('is true when the person holds every permission of the role', () => {
    const can = holds(Permissions.TEAM_VIEW, Permissions.TEAM_INVITE)
    expect(canGrant({ permissions: [Permissions.TEAM_VIEW] }, can)).toBe(true)
    expect(canGrant({ permissions: [] }, can)).toBe(true)
  })

  it('is false when one is missing, or the name is not a permission', () => {
    const can = holds(Permissions.TEAM_VIEW)
    expect(canGrant({ permissions: [Permissions.TEAM_VIEW, Permissions.TEAM_REMOVE] }, can)).toBe(
      false
    )
    expect(canGrant({ permissions: ['made:up'] }, can)).toBe(false)
  })
})
