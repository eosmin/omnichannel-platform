import { z } from 'zod'

import { ApiError, type SendMessageInput, StorageKeys } from '@platform/api-client'
import { MessageType } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

// A refusal of the request itself (a 4xx) will be the same on every retry: the message stays in the
// queue for the agent to read, edit or discard, and the ones behind it go on. A 401 is the session
// (refreshed, or lost and handled elsewhere), a 408 and a 429 pass; none of them says anything of the
// message. Anything else (the network, a 5xx) stops the pass until the next try.
const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([
  HttpStatusCodes.UNAUTHORIZED,
  HttpStatusCodes.REQUEST_TIMEOUT,
  HttpStatusCodes.TOO_MANY_REQUESTS
])

function isRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status >= HttpStatusCodes.BAD_REQUEST &&
    error.status < HttpStatusCodes.INTERNAL_SERVER_ERROR &&
    !RETRYABLE_CLIENT_STATUSES.has(error.status)
  )
}

// What `lastError` holds when the queue itself, and not the api, stopped a message
export const OfflineQueueErrors = {
  // Waited longer than the window for its connection to come back: it asks the agent before it goes
  EXPIRED: 'OFFLINE_QUEUE_EXPIRED'
} as const

const pendingMessageSchema = z.object({
  // Also the idempotencyKey of the request: a retry returns the message that exists
  id: z.string().min(1),
  // Whose message it is: the queue lives in localStorage, which the next person to sign in on this
  // browser shares, and a reply must never go out under another name
  userId: z.string().min(1),
  storeId: z.string().min(1),
  conversationId: z.string().min(1),
  type: z.enum([MessageType.TEXT, MessageType.INTERNAL_NOTE]),
  content: z.string(),
  mentions: z.array(z.string()).default([]),
  createdAt: z.string(),
  lastError: z.string().nullable()
})
const pendingMessagesSchema = z.array(pendingMessageSchema)

export type PendingMessage = z.output<typeof pendingMessageSchema>
export type NewPendingMessage = Omit<
  PendingMessage,
  'id' | 'createdAt' | 'lastError' | 'mentions'
> &
  Partial<Pick<PendingMessage, 'mentions'>>

export interface OfflineQueueDeps {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  send: (storeId: string, input: SendMessageInput) => Promise<unknown>
  newId: () => string
  now: () => Date
  // See RealtimeClientTiming.QUEUE_AUTO_SEND_WINDOW_MS
  autoSendWindowMs: number
}

// Messages written while the connection is down, sent on their own when it returns if that is soon
// enough (a longer wait asks the agent first). The storage is the source of truth and every
// change reads it first, because two tabs share it: a tab that wrote from a copy in memory would
// erase what the other one queued. Read and write are not atomic across tabs, so a change that lands
// between them in the other tab can still be lost: the window is a few microseconds, and closing it
// would take a lock around every change. Two tabs may flush the same message; the idempotencyKey makes the
// second send return the first message instead of creating another.
export class OfflineQueue {
  private fallback: PendingMessage[] = []
  private flushing: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshot: { revision: number; messages: readonly PendingMessage[] } | null = null

  constructor(private readonly deps: OfflineQueueDeps) {}

  enqueue(message: NewPendingMessage): PendingMessage {
    const pending: PendingMessage = {
      mentions: [],
      ...message,
      id: this.deps.newId(),
      createdAt: this.deps.now().toISOString(),
      lastError: null
    }
    this.write([...this.read(), pending])
    return pending
  }

  // Sends, in order, what is waiting for this person. A transient failure (the network, a 5xx, an
  // expired session) stops the pass and leaves everything for the next connection; a terminal one
  // marks that message and goes on with the next. Passes do not overlap.
  flush(userId: string): Promise<void> {
    this.flushing ??= this.run(userId).finally(() => {
      this.flushing = null
    })
    return this.flushing
  }

  // For a screen that draws the queue: the same array until something changes, which is what
  // useSyncExternalStore needs from a snapshot
  all(): readonly PendingMessage[] {
    if (this.snapshot?.revision !== this.revision) {
      this.snapshot = { revision: this.revision, messages: this.read() }
    }
    return this.snapshot.messages
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // Another tab wrote to the storage: what this one holds in its snapshot is out of date
  changedElsewhere(): void {
    this.changed()
  }

  waiting(userId: string): PendingMessage[] {
    return this.read().filter(m => m.userId === userId && m.lastError === null)
  }

  failed(userId: string): PendingMessage[] {
    return this.read().filter(m => m.userId === userId && m.lastError !== null)
  }

  discard(id: string): void {
    this.write(this.read().filter(m => m.id !== id))
  }

  // The agent confirms a message that waited too long: it gets a new window and goes out with the
  // next pass. It keeps its id, so if it had in fact been sent the api answers with the existing one.
  // A message that the api refused is not offered again: it would be refused again.
  resend(id: string, userId: string): boolean {
    const messages = this.read()
    const target = messages.find(
      m => m.id === id && m.userId === userId && m.lastError === OfflineQueueErrors.EXPIRED
    )
    if (target === undefined) return false
    this.write(
      messages.map(m =>
        m.id === id ? { ...m, lastError: null, createdAt: this.deps.now().toISOString() } : m
      )
    )
    return true
  }

  private async run(userId: string): Promise<void> {
    for (const message of this.waiting(userId)) {
      // Another tab may have sent it, or the agent discarded it, since the pass began
      if (!this.waiting(userId).some(m => m.id === message.id)) continue
      if (this.waitedTooLong(message)) {
        this.markFailed(message.id, OfflineQueueErrors.EXPIRED)
        continue
      }
      try {
        await this.deps.send(message.storeId, {
          type: message.type,
          conversationId: message.conversationId,
          content: message.content,
          idempotencyKey: message.id,
          ...(message.type === MessageType.INTERNAL_NOTE ? { mentions: message.mentions } : {})
        })
        this.discard(message.id)
      } catch (error) {
        // The api answered 2xx with a body this page cannot read: the message exists, and sending it
        // again would be answered the same way
        if (error instanceof z.ZodError) {
          this.discard(message.id)
          continue
        }
        if (isRefusal(error)) {
          this.markFailed(message.id, error.code)
          continue
        }
        return
      }
    }
  }

  private waitedTooLong(message: PendingMessage): boolean {
    return this.deps.now().getTime() - Date.parse(message.createdAt) > this.deps.autoSendWindowMs
  }

  private markFailed(id: string, code: string): void {
    this.write(this.read().map(m => (m.id === id ? { ...m, lastError: code } : m)))
  }

  private read(): PendingMessage[] {
    try {
      const stored = this.deps.storage.getItem(StorageKeys.PENDING_MESSAGES)
      if (stored === null) return this.fallback
      // Zod at the storage boundary: another version of the app or the person may have written it
      return pendingMessagesSchema.parse(JSON.parse(stored))
    } catch {
      return this.fallback
    }
  }

  private write(messages: PendingMessage[]): void {
    this.fallback = messages
    try {
      this.deps.storage.setItem(StorageKeys.PENDING_MESSAGES, JSON.stringify(messages))
    } catch {
      // Quota or blocked storage: the copy in memory keeps the queue for as long as the page lives
    }
    this.changed()
  }

  private changed(): void {
    this.revision += 1
    this.listeners.forEach(listener => listener())
  }
}
