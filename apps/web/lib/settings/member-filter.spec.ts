import { MembershipStatus } from '@platform/core/domain'

import { filterMembers, isSuspendedMember, MemberFilters } from './member-filter'
import type { MemberView } from './team-requests'

const member = (id: string, status: MemberView['status']): MemberView => ({
  id,
  userId: `u-${id}`,
  name: id,
  email: `${id}@example.com`,
  role: { id: 'r', name: 'Agent' },
  joinedAt: '2026-01-01T00:00:00.000Z',
  status
})

const active = member('a', MembershipStatus.ACTIVE)
const suspended = member('b', MembershipStatus.SUSPENDED)
const members = [active, suspended, member('c', MembershipStatus.ACTIVE)]

describe('filterMembers', () => {
  it('keeps everyone for all', () => {
    expect(filterMembers(members, MemberFilters.ALL).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps only the active ones', () => {
    expect(filterMembers(members, MemberFilters.ACTIVE).map(m => m.id)).toEqual(['a', 'c'])
  })

  it('keeps only the suspended ones', () => {
    expect(filterMembers(members, MemberFilters.SUSPENDED).map(m => m.id)).toEqual(['b'])
  })
})

describe('isSuspendedMember', () => {
  it('tells a suspended member from an active one', () => {
    expect(isSuspendedMember(suspended)).toBe(true)
    expect(isSuspendedMember(active)).toBe(false)
  })
})
