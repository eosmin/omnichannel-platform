import { ClientPermissions } from './client-permissions'
import { Permissions } from './permissions'

describe('ClientPermissions', () => {
  it('holds only permissions of the full table, under the same name and value', () => {
    const full: Record<string, string> = Permissions
    for (const [name, value] of Object.entries(ClientPermissions)) {
      expect(full[name]).toBe(value)
    }
  })
})
