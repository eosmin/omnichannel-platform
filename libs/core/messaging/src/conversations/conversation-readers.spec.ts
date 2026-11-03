import { MembershipStatus } from '@platform/core/domain'

import { conversationReaders } from './conversation-readers'

describe('conversationReaders', () => {
  const filter = conversationReaders(
    { hidden: false, assignedTo: null },
    { storeId: 'store-1', notes: false }
  )

  it('keeps to the members of the store who are active', () => {
    expect(filter).toMatchObject({
      storeId: 'store-1',
      status: MembershipStatus.ACTIVE,
      revokedAt: null
    })
  })

  it('does not match a member who is suspended, or one who was revoked', () => {
    // The only status it asks for is ACTIVE: a filter on anything wider would read a suspended
    // member as someone who may be told about a conversation
    expect(filter.status).toBe(MembershipStatus.ACTIVE)
    expect(filter.status).not.toBe(MembershipStatus.SUSPENDED)
    expect(filter.status).not.toBe(MembershipStatus.REVOKED)
  })
})
