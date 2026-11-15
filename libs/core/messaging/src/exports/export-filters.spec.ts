import { Permissions } from '@platform/core/auth'
import { BulkLimits } from '@platform/core/domain'

import {
  conversationsExportFiltersSchema,
  customersExportFiltersSchema,
  ordersExportFiltersSchema,
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

describe('the requester frozen in an export row', () => {
  const held = [Permissions.CONVERSATIONS_VIEW]
  const parse = (userId: string) =>
    conversationsExportFiltersSchema.safeParse({ filter: {}, viewer: { userId, held } }).success

  it('is a person or a plugin of the form plugin:<uuid>, so the file of a plugin is not refused when it is made', () => {
    expect(parse(crypto.randomUUID())).toBe(true)
    expect(parse(`plugin:${crypto.randomUUID()}`)).toBe(true)
  })

  it('refuses anything else, so a row cannot name an id that is neither', () => {
    expect(parse('plugin:')).toBe(false)
    expect(parse('plugin:not-a-uuid')).toBe(false)
    expect(parse(`system:${crypto.randomUUID()}`)).toBe(false)
    expect(parse(`plugin:${crypto.randomUUID()}x`)).toBe(false)
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

  it('keeps an orders row with its resolved days and refuses one that names a store or an unresolved shortcut', () => {
    expect(
      ordersExportFiltersSchema.safeParse({
        q: 'ana',
        status: 'SHIPPED',
        createdFrom: '2026-11-10T06:00:00.000Z',
        createdBefore: '2026-11-11T06:00:00.000Z',
        scheduledDeliveryFrom: '2026-11-12'
      }).success
    ).toBe(true)
    expect(ordersExportFiltersSchema.safeParse({}).success).toBe(true)
    expect(ordersExportFiltersSchema.safeParse({ storeId: 'x' }).success).toBe(false)
    expect(ordersExportFiltersSchema.safeParse({ scheduledDeliveryOn: 'today' }).success).toBe(
      false
    )
    expect(ordersExportFiltersSchema.safeParse({ status: 'NOPE' }).success).toBe(false)
    expect(ordersExportFiltersSchema.safeParse({ createdFrom: '2026-11-10' }).success).toBe(false)
  })
})
