import {
  type WidgetDeliveryState,
  WidgetAuthors,
  WidgetDeliveryStates
} from '@platform/core/domain'

import type { ChatMessage, ServerMessage } from './types'

type Listener = (messages: readonly ChatMessage[]) => void

function fromServer(message: ServerMessage): ChatMessage {
  return {
    key: message.id,
    serverId: message.id,
    from: message.from,
    content: message.content,
    createdAt: message.createdAt,
    state: WidgetDeliveryStates.SENT
  }
}

// The conversation as the visitor sees it. The server is the truth, and the browser adds only what it
// has not heard back from yet.
export class ChatLog {
  private items: ChatMessage[] = []
  private readonly listeners = new Set<Listener>()

  get messages(): readonly ChatMessage[] {
    return this.items
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // The history the api returns replaces what came from the server before, except a reply that the
  // socket pushed while the request was in flight: it is newer than the last line of the history.
  // A message of the visitor that left the browser but is not in the history yet (the worker has not
  // stored it) stays; one that is in it, by its text, gives way to the stored one so that it does not
  // show twice. Only lines the log did not know can be that stored copy: "hola" said yesterday is not
  // the "hola" said now.
  loadHistory(history: readonly ServerMessage[]): void {
    const known = new Set(this.items.map(item => item.serverId))
    const unmatched = history.filter(
      message => message.from === WidgetAuthors.VISITOR && !known.has(message.id)
    )
    const ids = new Set(history.map(message => message.id))
    const snapshotEnd = history[history.length - 1]?.createdAt ?? ''
    const pushed = this.items.filter(
      item => item.serverId !== null && !ids.has(item.serverId) && item.createdAt > snapshotEnd
    )
    const local = this.items.filter(item => {
      if (item.serverId !== null) return false
      if (item.state !== WidgetDeliveryStates.SENT) return true
      const stored = unmatched.findIndex(message => message.content === item.content)
      if (stored === -1) return true
      unmatched.splice(stored, 1)
      return false
    })
    this.items = [...history.map(fromServer), ...pushed, ...local]
    this.emit()
  }

  // A reply pushed by the socket; one the history already holds is not added again
  addIncoming(message: ServerMessage): void {
    if (this.items.some(item => item.serverId === message.id)) return
    this.items = [...this.items, fromServer(message)]
    this.emit()
  }

  addOutgoing(key: string, content: string): void {
    this.items = [
      ...this.items,
      {
        key,
        serverId: null,
        from: WidgetAuthors.VISITOR,
        content,
        createdAt: new Date().toISOString(),
        state: WidgetDeliveryStates.SENDING
      }
    ]
    this.emit()
  }

  setState(key: string, state: WidgetDeliveryState): void {
    this.items = this.items.map(item => (item.key === key ? { ...item, state } : item))
    this.emit()
  }

  find(key: string): ChatMessage | undefined {
    return this.items.find(item => item.key === key)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.items)
  }
}
