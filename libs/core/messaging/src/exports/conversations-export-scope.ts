import { Permissions } from '@platform/core/auth'
import { ConversationHiddenStatuses } from '@platform/core/domain'

import {
  assignedFilter,
  conversationFilterWhere,
  visibleTo,
  type Viewer
} from '../conversations/conversations.support'

import type { ConversationsExportFilters } from './export-filters'

// The requester of an export as the row froze them: the assignment of each conversation is read when the
// file is made, the permissions are those of the request
export function exportViewerOf(filters: ConversationsExportFilters): Viewer {
  const { userId, held } = filters.viewer
  return { userId, held, canViewAll: held.includes(Permissions.CONVERSATIONS_VIEW_ALL) }
}

export interface ConversationsExportWhere {
  storeId: string
  id?: { in: string[] }
  status?: string | { notIn: string[] }
  channelType?: string
  tags?: { some: { id: string } }
  AND: { OR?: { assignedTo: string | null }[]; assignedTo?: string | null }[]
}

// Which conversations a conversations export holds, in one place for the file and for whoever checks a
// selection before the row is written. A selection by ids sees the same conversations as the list
// does: the store, the ones assigned to the requester or to nobody (unless they see all), and the
// archived or spam ones only when the requester may archive. A filter works as the list does.
export function conversationsExportWhere(
  storeId: string,
  filters: ConversationsExportFilters
): ConversationsExportWhere {
  const viewer = exportViewerOf(filters)
  if (filters.conversationIds !== undefined) {
    const mayReadHidden = viewer.held.includes(Permissions.CONVERSATIONS_ARCHIVE)
    return {
      storeId,
      id: { in: filters.conversationIds },
      ...(mayReadHidden ? {} : { status: { notIn: [...ConversationHiddenStatuses] } }),
      AND: [visibleTo(viewer)]
    }
  }
  return {
    ...conversationFilterWhere(storeId, filters.filter, viewer),
    AND: [visibleTo(viewer), assignedFilter(filters.filter.assigned, viewer)]
  }
}
