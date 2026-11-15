import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

// The matrix of a role draws a name for every group and permission from the messages (a key that is missing is drawn as the
// key itself, long and unbreakable, which widens the dialog on a phone)
describe('the names of the permission matrix', () => {
  for (const locale of ['en', 'es']) {
    it(`has a text for every group and permission in ${locale}`, () => {
      const messages = JSON.parse(
        readFileSync(join(__dirname, '../../messages', `${locale}.json`), 'utf8')
      ) as {
        settings: {
          team: {
            permissionGroups: Record<string, string>
            permissions: Record<string, Record<string, string>>
          }
        }
      }
      const { permissionGroups: groupNames, permissions: names } = messages.settings.team
      for (const { group, permissions } of permissionGroups()) {
        expect(groupNames[group]?.length ?? 0).toBeGreaterThan(0)
        for (const { action } of permissions) {
          expect(names[group]?.[action]?.length ?? 0).toBeGreaterThan(0)
        }
      }
    })
  }
})
