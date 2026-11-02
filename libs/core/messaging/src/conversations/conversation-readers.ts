import { type Permission, Permissions } from '@platform/core/auth'
import type { MembershipWhereInput } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import type { ConversationVisibility } from '@platform/core/events'

// Who may open a conversation and read it, as a filter on memberships: an active member whose role
// reads conversations and messages (and notes, when `notes` is set), who may open an archived or spam
// conversation if it is one, and who may see one assigned to someone else only with VIEW_ALL (the
// assignee always may). One rule for the mention check when a note is written, the mention
// notification and the notification of an infected file: they must never disagree.
// The result owns `AND`: add other conditions with `userId` and the like, never another `AND`/`OR`.
export function conversationReaders(
  visibility: ConversationVisibility,
  options: { storeId: string; notes: boolean }
): MembershipWhereInput {
  const needed: Permission[] = [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]
  if (options.notes) needed.push(Permissions.MESSAGES_INTERNAL_NOTE)
  if (visibility.hidden) needed.push(Permissions.CONVERSATIONS_ARCHIVE)
  return {
    storeId: options.storeId,
    status: MembershipStatus.ACTIVE,
    revokedAt: null,
    AND: [
      ...needed.map(name => ({ role: { permissions: { some: { name } } } })),
      visibility.assignedTo === null
        ? {}
        : {
            OR: [
              { userId: visibility.assignedTo },
              { role: { permissions: { some: { name: Permissions.CONVERSATIONS_VIEW_ALL } } } }
            ]
          }
    ]
  }
}
