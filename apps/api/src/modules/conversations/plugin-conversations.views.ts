import type { AttentionReason } from '@platform/core/domain'
import type {
  ConversationCounts,
  ConversationDetail,
  ConversationListItem,
  ConversationPage
} from '@platform/core/messaging'

// What a conversation says of its customer to a plugin (PR plugin-conversations-identity, owner's decision of 2026-11-17).
//
// The name, the handle of the channel (`displayIdentity`, a phone number on a phone channel), the username, the photo and the caution flag
// are the identity of the customer, and the note an agent wrote on the mark of the conversation is text about them: a key that holds
// `conversations:read` and not `customers:read` is told none of them. It is told the id of the customer, which stands for them without
// naming them (the pseudonym a plugin can group the conversations of one person by).
//
// `assignedTo` stays for every key: it is the id of a member of the team, no name, and the route that assigns a conversation needs it.
//
// The two fields of a conversation that say who the customer is, as a key without `customers:read` is told them
interface HiddenIdentity {
  customer: { id: string }
  attention: { reason: AttentionReason; at: Date } | null
}

const hidden = (item: ConversationListItem): HiddenIdentity => ({
  customer: { id: item.customer.id },
  attention:
    item.attention === null ? null : { reason: item.attention.reason, at: item.attention.at }
})

export type PluginConversationItem = Omit<ConversationListItem, keyof HiddenIdentity> &
  HiddenIdentity
// `resolutionReason` is text an agent wrote when they resolved the conversation, as free as the note of the mark: it is the customer's to see
// with the rest, and a key without `customers:read` is told it was left out (null)
export type PluginConversationDetail = Omit<
  ConversationDetail,
  keyof HiddenIdentity | 'resolutionReason'
> &
  HiddenIdentity & { resolutionReason: null }

// Field by field, so that a field the conversation gains tomorrow is not told to a key before somebody decides whether it is the customer's
function itemFieldsOf(
  item: ConversationListItem
): Omit<ConversationListItem, keyof HiddenIdentity> {
  return {
    id: item.id,
    status: item.status,
    channelType: item.channelType,
    assignedTo: item.assignedTo,
    unreadCount: item.unreadCount,
    lastMessageAt: item.lastMessageAt,
    snoozedUntil: item.snoozedUntil,
    lastMessage: item.lastMessage,
    tags: item.tags
  }
}

function hideItemCustomer(item: ConversationListItem): PluginConversationItem {
  return { ...itemFieldsOf(item), ...hidden(item) }
}

function hideDetailCustomer(detail: ConversationDetail): PluginConversationDetail {
  return {
    ...itemFieldsOf(detail),
    channelConnectionId: detail.channelConnectionId,
    lastInboundAt: detail.lastInboundAt,
    lastReadAt: detail.lastReadAt,
    resolvedAt: detail.resolvedAt,
    resolutionReason: null,
    createdAt: detail.createdAt,
    ...hidden(detail)
  }
}

export function itemForKey(
  item: ConversationListItem,
  holdsCustomers: boolean
): ConversationListItem | PluginConversationItem {
  return holdsCustomers ? item : hideItemCustomer(item)
}

export function detailForKey(
  detail: ConversationDetail,
  holdsCustomers: boolean
): ConversationDetail | PluginConversationDetail {
  return holdsCustomers ? detail : hideDetailCustomer(detail)
}

export type PluginConversationPage = Omit<ConversationPage, 'data'> & {
  data: (ConversationListItem | PluginConversationItem)[]
}

export function pageForKey(
  page: ConversationPage,
  holdsCustomers: boolean
): PluginConversationPage {
  return { ...page, data: page.data.map(item => itemForKey(item, holdsCustomers)) }
}

// The numbers beside the filters, without the load of each member of the team (the analytics routes of a plugin refuse it too): the owner's
// decision of 2026-11-17. A key still reads `assignedTo` of each conversation, which an assignment needs, so it can add the load up from
// the list: this is the least a key is handed, not a wall (see the plan, "Left by PR plugin-conversations-identity" (b))
export type PluginConversationCounts = Omit<ConversationCounts, 'byAgent' | 'activeByAgent'>

export function withoutAgentLoad(counts: ConversationCounts): PluginConversationCounts {
  return {
    all: counts.all,
    mine: counts.mine,
    unassigned: counts.unassigned,
    byStatus: counts.byStatus,
    byChannel: counts.byChannel
  }
}
