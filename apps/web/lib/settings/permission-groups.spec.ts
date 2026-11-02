import { Permissions } from '@platform/core/auth'

import { permissionGroups, toggled } from './permission-groups'

describe('permissionGroups', () => {
  it('holds every permission once, under the area before the colon', () => {
    const groups = permissionGroups()
    const all = groups.flatMap(g => g.permissions.map(p => p.permission))
    expect(all.sort()).toEqual(Object.values(Permissions).sort())
    for (const { group, permissions } of groups) {
      for (const { permission, action } of permissions) {
        expect(permission).toBe(`${group}:${action}`)
      }
    }
  })

  it('keeps the team permissions together', () => {
    const team = permissionGroups().find(g => g.group === 'team')
    expect(team?.permissions.map(p => p.permission)).toEqual([
      Permissions.TEAM_VIEW,
      Permissions.TEAM_INVITE,
      Permissions.TEAM_REMOVE,
      Permissions.TEAM_MANAGE_ROLES
    ])
  })
})

describe('toggled', () => {
  it('adds what is missing and removes what is there, without repeats', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggled(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggled([], 'a')).toEqual(['a'])
  })
})
