import { RoleNames } from '@platform/core/auth'

import en from '../messages/en.json'
import es from '../messages/es.json'

// `useRoleLabel` looks the name of a system role up by itself: a role without a message would show
// an error in the interface
describe('the names of the system roles', () => {
  it('have a message in each language', () => {
    for (const name of Object.values(RoleNames)) {
      expect(es.settings.team.roleNames).toHaveProperty(name)
      expect(en.settings.team.roleNames).toHaveProperty(name)
    }
  })
})
