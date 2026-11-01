import { Permissions } from '@platform/core/auth'

import { conversationsExportWhere } from './conversations-export-scope'
import type { ConversationsExportFilters } from './export-filters'

const STORE = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const IDS = ['33333333-3333-4333-8333-333333333333']

const filtersOf = (
  held: ConversationsExportFilters['viewer']['held'],
  extra: Partial<ConversationsExportFilters> = {}
): ConversationsExportFilters => ({ filter: {}, viewer: { userId: USER, held }, ...extra })

describe('conversationsExportWhere', () => {
  it('keeps a selection inside the store and what the requester sees', () => {
    const where = conversationsExportWhere(
      STORE,
      filtersOf([Permissions.CONVERSATIONS_VIEW], { conversationIds: IDS })
    )
    expect(where).toMatchObject({ storeId: STORE, id: { in: IDS } })
    expect(where.AND).toEqual([{ OR: [{ assignedTo: null }, { assignedTo: USER }] }])
  })

  it('leaves out archived and spam from a selection unless the requester may archive', () => {
    const without = conversationsExportWhere(
      STORE,
      filtersOf([Permissions.CONVERSATIONS_VIEW], { conversationIds: IDS })
    )
    const withArchive = conversationsExportWhere(
      STORE,
      filtersOf([Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_ARCHIVE], {
        conversationIds: IDS
      })
    )
    expect(without).toHaveProperty('status.notIn')
    expect(withArchive).not.toHaveProperty('status')
  })

  it('does not narrow a selection by assignment for who sees all', () => {
    const where = conversationsExportWhere(
      STORE,
      filtersOf([Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_VIEW_ALL], {
        conversationIds: IDS
      })
    )
    expect(where.AND).toEqual([{}])
  })

  it('works as the list does when there is no selection', () => {
    const where = conversationsExportWhere(STORE, filtersOf([Permissions.CONVERSATIONS_VIEW]))
    expect(where).toHaveProperty('status.notIn')
    expect(where).not.toHaveProperty('id')
  })
})
