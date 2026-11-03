import { MembershipStatus } from '@platform/core/domain'

import type { MemberView } from './team-requests'

// The filter of Settings → Team → Members by status
export const MemberFilters = {
  ALL: 'all',
  ACTIVE: 'active',
  SUSPENDED: 'suspended'
} as const
export type MemberFilter = (typeof MemberFilters)[keyof typeof MemberFilters]

export function isSuspendedMember(member: Pick<MemberView, 'status'>): boolean {
  return member.status === MembershipStatus.SUSPENDED
}

export function filterMembers(
  members: readonly MemberView[],
  filter: MemberFilter
): readonly MemberView[] {
  if (filter === MemberFilters.ALL) return members
  return members.filter(
    member => isSuspendedMember(member) === (filter === MemberFilters.SUSPENDED)
  )
}
