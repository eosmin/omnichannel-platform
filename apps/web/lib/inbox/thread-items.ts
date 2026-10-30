import type { MessageView } from '@platform/api-client'
import { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'

// Messages of the same author this close together are one block: the name and the avatar show once
const GROUP_WINDOW_MS = 5 * 60_000

export type ThreadItem =
  | { kind: 'day'; key: string; at: Date }
  | { kind: 'message'; message: MessageView; showAuthor: boolean }

// How a message is drawn. `message` is a bubble with text; `media` a bubble that names the file (the
// file itself waits for the storage of Step 3.4); `neutral` is a line, for a type with no bubble yet.
export type MessageKind = 'system' | 'deleted' | 'note' | 'message' | 'media' | 'neutral'

const MEDIA_TYPES: readonly string[] = [
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
]
const TEXT_TYPES: readonly string[] = [MessageType.TEXT, MessageType.TEMPLATE]

export function messageKindOf(message: MessageView): MessageKind {
  if (message.type === String(MessageType.SYSTEM) && message.system !== null) return 'system'
  if (message.deletedAt !== null) return 'deleted'
  if (message.type === String(MessageType.INTERNAL_NOTE)) return 'note'
  if (MEDIA_TYPES.includes(message.type)) return 'media'
  if (TEXT_TYPES.includes(message.type)) return 'message'
  return 'neutral'
}

// The customer is on the left; the team (agents, the owner's own phone, a plugin) on the right
export const isFromCustomer = (message: MessageView): boolean =>
  message.authorType === String(AuthorType.CUSTOMER)

// What the ticks of a reply show; null for what is not a reply to a customer
export type DeliveryTicks = DeliveryStatus

export function deliveryTicksOf(message: MessageView): DeliveryTicks | null {
  if (message.authorType !== String(AuthorType.AGENT)) return null
  return Object.values(DeliveryStatus).find(status => status === message.deliveryStatus) ?? null
}

// The day a moment falls on in the zone of who reads, as a stable key
function dayKeyOf(at: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at)
}

function startsBlock(previous: MessageView | null, message: MessageView): boolean {
  if (previous === null) return true
  const kinds = [messageKindOf(previous), messageKindOf(message)]
  if (kinds.includes('system') || kinds.includes('neutral')) return true
  if ((kinds[0] === 'note') !== (kinds[1] === 'note')) return true
  return (
    previous.authorType !== message.authorType ||
    previous.authorId !== message.authorId ||
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() > GROUP_WINDOW_MS
  )
}

// The pages come newest first and a page may repeat a message the next refetch moved across a
// boundary; the thread is drawn oldest first, with a divider at each new day
export function buildThreadItems(
  pages: readonly (readonly MessageView[])[],
  timeZone?: string
): ThreadItem[] {
  const seen = new Set<string>()
  const oldestFirst = pages
    .flat()
    .filter(message => !seen.has(message.id) && seen.add(message.id))
    .reverse()

  const items: ThreadItem[] = []
  let previous: MessageView | null = null
  let day: string | null = null
  for (const message of oldestFirst) {
    const at = new Date(message.createdAt)
    const key = dayKeyOf(at, timeZone)
    const isNewDay = key !== day
    if (isNewDay) items.push({ kind: 'day', key, at })
    day = key
    items.push({
      kind: 'message',
      message,
      showAuthor: isNewDay || startsBlock(previous, message)
    })
    previous = message
  }
  return items
}

// The members the thread names (authors, who deleted, who a line assigned to): the directory is read
// again when one of them is missing from it, because a member can join while the page is open
export function memberIdsOf(items: readonly ThreadItem[]): string[] {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'message') continue
    const { message } = item
    if (message.authorType === String(AuthorType.AGENT) && message.authorId !== null) {
      ids.add(message.authorId)
    }
    if (message.deletedByType === String(AuthorType.AGENT) && message.deletedById !== null) {
      ids.add(message.deletedById)
    }
    for (const id of [message.system?.actor.id, message.system?.assignedTo]) {
      if (id !== undefined && id !== null) ids.add(id)
    }
  }
  return [...ids]
}
