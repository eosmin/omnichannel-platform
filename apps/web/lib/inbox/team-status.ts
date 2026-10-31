import type { MemberDirectoryEntryView, UserPresenceView } from '@platform/api-client'
import { PresenceStatus } from '@platform/core/realtime'

export interface TeamStatusRow {
  userId: string
  name: string
  status: PresenceStatus
  // null when the viewer may not see the load of the team
  active: number | null
  isOverThreshold: boolean
}

const ORDER: readonly PresenceStatus[] = [
  PresenceStatus.ONLINE,
  PresenceStatus.AWAY,
  PresenceStatus.OFFLINE
]

// Who is online first, then away, then offline, each by name. The load is the conversations still to
// be worked and is given only to who may see every conversation: the counts of the others cover only
// what they may see, so a number drawn for them would be wrong. `threshold` flags a load that has
// reached it (`StoreSettings.agentLoadThreshold`).
export function buildTeamRows({
  members,
  presence,
  activeByAgent,
  threshold,
  showLoad
}: {
  members: readonly MemberDirectoryEntryView[]
  presence: readonly UserPresenceView[]
  activeByAgent: readonly { userId: string; count: number }[]
  threshold: number | null
  showLoad: boolean
}): TeamStatusRow[] {
  const statusOf = new Map(presence.map(entry => [entry.userId, entry.status]))
  const loadOf = new Map(activeByAgent.map(entry => [entry.userId, entry.count]))
  const rows = members.map(member => {
    const active = showLoad ? (loadOf.get(member.id) ?? 0) : null
    return {
      userId: member.id,
      name: member.name,
      status: statusOf.get(member.id) ?? PresenceStatus.OFFLINE,
      active,
      isOverThreshold: active !== null && threshold !== null && active >= threshold
    }
  })
  return rows.sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.name.localeCompare(b.name)
  )
}
