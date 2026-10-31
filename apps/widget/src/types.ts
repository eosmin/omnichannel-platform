import type { WidgetAuthor, WidgetDeliveryState } from '@platform/core/domain'

// What the api answers (apps/api/src/modules/widget): the script is served on other people's sites and
// cannot trust it blindly, so api.ts checks the shape before any of it is used.
export interface ServerMessage {
  id: string
  from: WidgetAuthor
  content: string
  createdAt: string
}

export interface Bootstrap {
  visitorToken: string
  expiresInSeconds: number
  store: { name: string; locale: string }
  away: boolean
  messages: ServerMessage[]
  // The latest message of the visitor that an agent read; null when none was
  readUpToMessageId: string | null
}

// A line of the conversation. A message the visitor just wrote has no server id until the history is
// read again; its key is the id the browser gave it, which is also what makes sending twice store once.
export interface ChatMessage {
  key: string
  serverId: string | null
  from: WidgetAuthor
  content: string
  createdAt: string
  state: WidgetDeliveryState
  // An agent read it: only a message of the visitor can be
  seen: boolean
}
