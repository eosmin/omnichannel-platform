import { Permissions } from '@platform/core/auth'

import {
  conversationsExportFiltersSchema,
  customersExportFiltersSchema,
  viewPermissionsOf
} from './export-filters'

describe('the filters an export row keeps', () => {
  it('keeps of the permissions of a member only the three that decide what they see', () => {
    expect(
      viewPermissionsOf([Permissions.CUSTOMERS_EXPORT, Permissions.CONVERSATIONS_VIEW_ALL])
    ).toEqual([Permissions.CONVERSATIONS_VIEW_ALL])
  })

  it('refuses a customers filter it does not know or a search of another type', () => {
    expect(customersExportFiltersSchema.safeParse({ q: 'ana' }).success).toBe(true)
    expect(customersExportFiltersSchema.safeParse({}).success).toBe(true)
    expect(customersExportFiltersSchema.safeParse({ q: 5 }).success).toBe(false)
    expect(customersExportFiltersSchema.safeParse({ storeId: 'x' }).success).toBe(false)
  })

  it('refuses a conversations row that names a permission outside the three', () => {
    const viewer = { userId: crypto.randomUUID(), held: [Permissions.TEAM_MANAGE_ROLES] }
    expect(conversationsExportFiltersSchema.safeParse({ filter: {}, viewer }).success).toBe(false)
    expect(
      conversationsExportFiltersSchema.safeParse({
        filter: {},
        viewer: { ...viewer, held: [Permissions.CONVERSATIONS_VIEW] }
      }).success
    ).toBe(true)
  })
})
