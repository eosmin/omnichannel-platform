import { Permissions } from '@platform/core/auth'
import { BulkLimits } from '@platform/core/domain'

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

describe('the selection of a conversations export', () => {
  const viewer = { userId: crypto.randomUUID(), held: [Permissions.CONVERSATIONS_VIEW] }

  it('takes ids with an empty filter, and refuses ids together with a filter', () => {
    const conversationIds = [crypto.randomUUID()]
    expect(
      conversationsExportFiltersSchema.safeParse({ filter: {}, conversationIds, viewer }).success
    ).toBe(true)
    expect(
      conversationsExportFiltersSchema.safeParse({
        filter: { channelType: 'whatsapp' },
        conversationIds,
        viewer
      }).success
    ).toBe(false)
  })

  it('refuses an empty list of ids, a repeated id and a list over the bulk limit', () => {
    const id = crypto.randomUUID()
    const parse = (conversationIds: string[]) =>
      conversationsExportFiltersSchema.safeParse({ filter: {}, conversationIds, viewer }).success
    expect(parse([])).toBe(false)
    expect(parse([id, id])).toBe(false)
    expect(parse(Array.from({ length: BulkLimits.MAX_ITEMS + 1 }, () => crypto.randomUUID()))).toBe(
      false
    )
  })
})
