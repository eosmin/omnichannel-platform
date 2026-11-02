import {
  type WidgetDeliveryState,
  WidgetAuthors,
  WidgetDeliveryStates
} from '@platform/core/domain'

import type { Attachment, ChatMessage, ServerMessage } from './types'

type Listener = (messages: readonly ChatMessage[]) => void

function fromServer(message: ServerMessage, seen: boolean): ChatMessage {
  return {
    key: message.id,
    serverId: message.id,
    from: message.from,
    content: message.content,
    attachments: message.attachments,
    progress: null,
    createdAt: message.createdAt,
    state: WidgetDeliveryStates.SENT,
    seen
  }
}

// The conversation as the visitor sees it. The server is the truth, and the browser adds only what it
// has not heard back from yet.
export class ChatLog {
  private items: ChatMessage[] = []
  // Kept apart from the lines because the history replaces them: a mark must outlive a reload of it
  private readonly seenIds = new Set<string>()
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
      // The same text and the same number of files: a file-only message has no text to tell it by
      const stored = unmatched.findIndex(
        message =>
          message.content === item.content && message.attachments.length === item.attachments.length
      )
      if (stored === -1) return true
      unmatched.splice(stored, 1)
      return false
    })
    this.items = [...history.map(message => this.fromServer(message)), ...pushed, ...local]
    this.emit()
  }

  // A reply pushed by the socket; one the history already holds is not added again
  addIncoming(message: ServerMessage): void {
    if (this.items.some(item => item.serverId === message.id)) return
    this.items = [...this.items, this.fromServer(message)]
    this.emit()
  }

  addOutgoing(key: string, content: string, attachments: readonly Attachment[] = []): void {
    this.items = [
      ...this.items,
      {
        key,
        serverId: null,
        from: WidgetAuthors.VISITOR,
        content,
        attachments,
        progress: attachments.length === 0 ? null : 0,
        createdAt: new Date().toISOString(),
        state: WidgetDeliveryStates.SENDING,
        seen: false
      }
    ]
    this.emit()
  }

  // An agent read the conversation up to this message of the visitor: it and every earlier one of theirs
  // are seen. An id this log does not hold is newer than all it knows (it came by the socket before the
  // history did), so every message of the visitor it knows is earlier.
  markSeenUpTo(messageId: string): void {
    const end = this.items.findIndex(item => item.serverId === messageId)
    const last = end === -1 ? this.items.length - 1 : end
    let changed = false
    this.items = this.items.map((item, index) => {
      if (index > last || item.from !== WidgetAuthors.VISITOR || item.serverId === null) return item
      this.seenIds.add(item.serverId)
      if (item.seen) return item
      changed = true
      return { ...item, seen: true }
    })
    if (changed) this.emit()
  }

  // The state of a message; one that is no longer sending has nothing going up
  setState(key: string, state: WidgetDeliveryState): void {
    this.items = this.items.map(item =>
      item.key === key
        ? {
            ...item,
            state,
            // A retry starts the files over, and shows the bar again
            progress:
              state === WidgetDeliveryStates.SENDING && item.attachments.length > 0
                ? (item.progress ?? 0)
                : null
          }
        : item
    )
    this.emit()
  }

  // How much of the files of a message has gone up, as a fraction of all of them
  setProgress(key: string, progress: number): void {
    this.items = this.items.map(item => (item.key === key ? { ...item, progress } : item))
    this.emit()
  }

  find(key: string): ChatMessage | undefined {
    return this.items.find(item => item.key === key)
  }

  private fromServer(message: ServerMessage): ChatMessage {
    return fromServer(message, this.seenIds.has(message.id))
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.items)
  }
}
