import { Injectable } from '@nestjs/common'

import { AssigneePermissions, type Permission, Permissions } from '@platform/core/auth'
import { lockStoreForWrite, PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  type AssignmentReason,
  AttentionReasons,
  ConversationConflictReasons,
  ConversationHiddenStatuses,
  ConversationLimits,
  ConversationStatus,
  type ConversationStatusReason,
  ConversationStatusReasons,
  ConversationStatusTransitions,
  DeliveryStatus,
  MembershipStatus,
  MessageType,
  OfActiveInstallation,
  ResolveUndo,
  SystemMessageEvents
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { type ActorRef, Events } from '@platform/core/events'

import { lockMessageRow, publishMessageChanged } from '../changes/message-changed'
import { isClosingMessage } from '../messages/closing-message'

import { afterConversationCursor, encodeConversationCursor } from './conversation-cursor'
import type { ConversationFilter, ListConversationsQuery } from './conversations.schemas'
import {
  assignedFilter,
  canSee,
  type ConversationActor,
  conversationFilterWhere,
  invalidInput,
  isHiddenStatus,
  lockConversationForWrite,
  requireAnyPermission,
  statusOf,
  type Viewer,
  visibleTo
} from './conversations.support'
import {
  type ConversationDetail,
  type ConversationPage,
  DETAIL_SELECT,
  LIST_SELECT,
  listItemsOf
} from './conversations.views'
import { systemEventFor, systemLineMetadataSchema, writeSystemLine } from './system-lines'

const DAY_MS = 24 * 60 * 60 * 1000
// A conversation is snoozed until a moment to come, within the limit
function assertSnoozeWindow(until: Date): void {
  const now = Date.now()
  if (until.getTime() <= now) {
    throw invalidInput('a conversation is snoozed until a moment to come')
  }
  if (until.getTime() > now + ConversationLimits.MAX_SNOOZE_DAYS * DAY_MS) {
    throw invalidInput(
      `a conversation is snoozed for at most ${ConversationLimits.MAX_SNOOZE_DAYS} days`
    )
  }
}

// A customer that was merged into another that was merged in turn: at most this many redirects
// are followed, the chain is short on purpose
const MAX_MERGE_HOPS = 5

// The permission each destination needs. Marking spam is an archive-level decision; reopening or
// putting on hold is working the conversation, which the read-only roles cannot do.
const STATUS_PERMISSIONS: Record<ConversationStatus, Permission> = {
  [ConversationStatus.OPEN]: Permissions.CONVERSATIONS_RESOLVE,
  [ConversationStatus.PENDING]: Permissions.CONVERSATIONS_RESOLVE,
  [ConversationStatus.RESOLVED]: Permissions.CONVERSATIONS_RESOLVE,
  [ConversationStatus.SNOOZED]: Permissions.CONVERSATIONS_SNOOZE,
  [ConversationStatus.ARCHIVED]: Permissions.CONVERSATIONS_ARCHIVE,
  [ConversationStatus.SPAM]: Permissions.CONVERSATIONS_ARCHIVE
}

export interface StatusTransition {
  from: ConversationStatus
  to: ConversationStatus
  retracted: boolean
}

export interface StatusOptions {
  actor: ConversationActor
  resolutionReason?: string
  // The change takes back the resolution that was just made (the Undo of the toast): the line says so
  undoesResolution?: boolean
  // Told once, after the commit, when the change really happened (not when it was refused or changed nothing):
  // what the status was, what it is, and whether the Undo took its "resolved" line off the thread. The api
  // writes the audit entry from it, so that the log says what the service did and not what was asked.
  afterTransition?: (done: StatusTransition) => void
  // Why the system changed it (a customer wrote); it goes to the system line
  reason?: ConversationStatusReason
  // Required to snooze: the moment the conversation comes back
  snoozedUntil?: Date
  // With a snooze: what the agent wants to remember, already trimmed and within the limit. Kept with the
  // snooze, shown when it wakes, never logged.
  snoozeNote?: string | null
  // For a change made by the system because of what a person did (a reply reopens the conversation):
  // the person, for the event. It grants nothing: the permission to act was checked by the caller.
  causedBy?: string
  // For a sweep that chose the conversation some moments ago: the change is made only if what made it
  // due still holds under the lock: the conversation is still in `status` and its snooze ends (or its
  // resolution dates) at or before `by`. A person who woke it, snoozed it, resolved it again or
  // archived it meanwhile is not overridden.
  onlyIfDue?: {
    status: ConversationStatus.SNOOZED | ConversationStatus.RESOLVED
    by: Date
  }
}

export interface NewConversation {
  customerId: string
  customerIdentityId: string
  channelConnectionId: string
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents
  ) {}

  // Called by the inbound pipeline (Step 2.6), not by a route: a conversation starts with a message
  // from a channel.
  async create(storeId: string, input: NewConversation): Promise<ConversationDetail> {
    const id = await this.prisma.transaction(tx => this.createIn(tx, storeId, input))
    return this.get(storeId, id)
  }

  // The same inside the transaction of the caller, which holds the store lock already. The customer is
  // locked FOR KEY SHARE and read again, because a merge may have absorbed it a moment ago: the
  // conversation goes to the survivor (MVP_TRIM_CHECKLIST item 27).
  async createIn(tx: PrismaTransaction, storeId: string, input: NewConversation): Promise<string> {
    await lockStoreForWrite(tx, storeId)
    const customerId = await this.survivorOf(tx, storeId, input.customerId)
    const identity = await tx.customerIdentity.findFirst({
      where: { id: input.customerIdentityId, storeId, customerId },
      select: { id: true, channelType: true }
    })
    if (identity === null) throw resourceNotFound('customer identity')
    const connection = await tx.channelConnection.findFirst({
      where: { id: input.channelConnectionId, storeId, ...OfActiveInstallation },
      select: { id: true, pluginId: true }
    })
    if (connection === null) throw resourceNotFound('channel connection')
    if (connection.pluginId !== identity.channelType) {
      throw resourceConflict('the identity and the connection are of different channels')
    }
    const created = await tx.conversation.create({
      data: {
        storeId,
        customerId,
        customerIdentityId: identity.id,
        channelConnectionId: connection.id,
        channelType: identity.channelType
      },
      select: { id: true }
    })
    return created.id
  }

  async list(
    storeId: string,
    query: ListConversationsQuery,
    viewer: Viewer,
    // The conversations of one customer (the profile): set by the server from the path, never by a
    // client, so it is not part of the query
    customerId?: string
  ): Promise<ConversationPage> {
    const { cursor } = query
    const rows = await this.prisma.client.conversation.findMany({
      where: {
        ...conversationFilterWhere(storeId, query, viewer),
        ...(customerId === undefined ? {} : { customerId }),
        AND: [
          visibleTo(viewer),
          assignedFilter(query.assigned, viewer),
          // After the last row of the previous page, in the order of the list
          cursor === undefined ? {} : afterConversationCursor(cursor)
        ]
      },
      select: LIST_SELECT,
      take: query.limit + 1,
      // A mark of attention raises a row; the rest are by their last message (index
      // conversations_store_list_order_idx serves this order)
      orderBy: [
        { attentionAt: { sort: 'desc', nulls: 'last' } },
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' }
      ]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: await listItemsOf(this.prisma.client, storeId, page, viewer),
      nextCursor:
        hasMore && last !== undefined
          ? encodeConversationCursor({
              attentionAt: last.attentionAt,
              lastMessageAt: last.lastMessageAt,
              id: last.id
            })
          : null,
      hasMore
    }
  }

  // The ids a bulk action reaches when it names a filter instead of ids ("select all 43 matching"):
  // the same filters and the same view as the list, the newest first, at most `limit`.
  async idsMatching(
    storeId: string,
    filter: ConversationFilter,
    viewer: Viewer,
    limit: number
  ): Promise<string[]> {
    const rows = await this.prisma.client.conversation.findMany({
      where: {
        ...conversationFilterWhere(storeId, filter, viewer),
        AND: [visibleTo(viewer), assignedFilter(filter.assigned, viewer)]
      },
      select: { id: true },
      take: limit,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]
    })
    return rows.map(row => row.id)
  }

  // How many conversations a filter reaches for the viewer, by the same rule as `idsMatching`
  async countMatching(
    storeId: string,
    filter: ConversationFilter,
    viewer: Viewer
  ): Promise<number> {
    return this.prisma.client.conversation.count({
      where: {
        ...conversationFilterWhere(storeId, filter, viewer),
        AND: [visibleTo(viewer), assignedFilter(filter.assigned, viewer)]
      }
    })
  }

  // Which of the ids the viewer may see: the same rule as the single routes, which answer "not found"
  // for a conversation of another store or one the viewer may not read
  async visibleAmong(
    storeId: string,
    ids: readonly string[],
    viewer: Viewer
  ): Promise<Set<string>> {
    const rows = await this.prisma.client.conversation.findMany({
      where: { storeId, id: { in: [...ids] } },
      select: { id: true, status: true, assignedTo: true }
    })
    return new Set(rows.filter(row => canSee(viewer, row)).map(row => row.id))
  }

  async get(
    storeId: string,
    conversationId: string,
    viewer?: Viewer,
    // For the answer to a change the caller was allowed to make (see `detail`)
    revealed = false
  ): Promise<ConversationDetail> {
    return this.detail(this.prisma.client, storeId, conversationId, viewer, revealed)
  }

  // Every status change of a conversation goes through here (TDD_02 section 5): the transition is
  // checked, the fields that depend on the status are set, and the row is written under its lock.
  async updateStatus(
    storeId: string,
    conversationId: string,
    to: ConversationStatus,
    options: StatusOptions
  ): Promise<ConversationDetail> {
    const viewer = options.actor === 'system' ? undefined : options.actor
    return this.prisma.transaction(async tx => {
      await this.applyStatus(tx, storeId, conversationId, to, options)
      return this.detail(tx, storeId, conversationId, viewer, true)
    })
  }

  // The change of status inside the transaction of the caller, for a write that has to change it
  // together with something else (a reply reopens the conversation it answers). The row is locked
  // again, which is two cheap statements when the caller holds the lock already.
  async applyStatus(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    to: ConversationStatus,
    options: StatusOptions
  ): Promise<void> {
    const viewer = options.actor === 'system' ? undefined : options.actor
    const current = await lockConversationForWrite(tx, storeId, conversationId, viewer)
    const from = statusOf(current.status)
    if (viewer !== undefined) {
      requireAnyPermission(viewer.held, [STATUS_PERMISSIONS[to]])
      // Archived and spam conversations never get here for who may not archive: they are not seen
    }
    if (options.onlyIfDue !== undefined) {
      const { status, by } = options.onlyIfDue
      const since =
        status === ConversationStatus.SNOOZED ? current.snoozedUntil : current.resolvedAt
      if (from !== status || since === null || since.getTime() > by.getTime()) {
        throw resourceConflict('the conversation is no longer due for this change', {
          reason: ConversationConflictReasons.NO_LONGER_DUE
        })
      }
    }
    if (to === ConversationStatus.RESOLVED && from === ConversationStatus.RESOLVED) {
      throw new PlatformException(
        ErrorCodes.CONVERSATION_ALREADY_RESOLVED,
        'the conversation is already resolved',
        HttpStatusCodes.CONFLICT
      )
    }
    if (!ConversationStatusTransitions[from].includes(to)) {
      throw new PlatformException(
        ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION,
        `a ${from} conversation cannot become ${to}`,
        HttpStatusCodes.CONFLICT,
        { from, to }
      )
    }
    if (to === ConversationStatus.SNOOZED) {
      if (options.snoozedUntil === undefined) {
        throw invalidInput('snoozing needs the moment the conversation comes back')
      }
      assertSnoozeWindow(options.snoozedUntil)
    }
    // A snooze that ran out raises the row until someone opens it (only the sweep of the worker gives
    // this reason: a customer who writes to a snoozed conversation wakes it too, but nobody's timer
    // ran out). A way out of the work (resolved, spam, snoozed again) takes the mark off; OPEN and PENDING
    // are still the work to do, so the mark stays through them. Any exit from the snooze drops the reminder.
    const woke =
      from === ConversationStatus.SNOOZED &&
      to === ConversationStatus.OPEN &&
      options.reason === ConversationStatusReasons.SNOOZE_EXPIRED
    const marks = woke
    const clearsMark = !marks && to !== ConversationStatus.OPEN && to !== ConversationStatus.PENDING
    await tx.conversation.update({
      where: { id: conversationId, storeId },
      data: {
        // eslint-disable-next-line no-restricted-syntax -- the one place that writes the status
        status: to,
        ...fieldsOf(to, options),
        ...(from === ConversationStatus.SNOOZED ? { snoozeNote: null } : {}),
        ...(marks
          ? {
              attentionReason: AttentionReasons.SNOOZE_WOKE,
              attentionAt: new Date(),
              attentionNote: current.snoozeNote
            }
          : clearsMark
            ? { attentionReason: null, attentionAt: null, attentionNote: null }
            : {})
      }
    })
    // The Undo of a resolution takes back what that resolution queued: its closing message, if the
    // worker has not claimed it. One that is in flight (marked by its claim) or gone is not touched.
    if (
      options.undoesResolution === true &&
      from === ConversationStatus.RESOLVED &&
      to === ConversationStatus.OPEN
    ) {
      await this.withdrawQueuedClosing(
        tx,
        storeId,
        conversationId,
        current.resolvedAt,
        options.actor === 'system' ? null : options.actor.userId
      )
    }
    // An Undo inside its window is a Ctrl+Z: the thread keeps no line that it was resolved and none that
    // it was undone (the audit log has both). Past the window, or by someone else, it is a reopening.
    const undid =
      options.undoesResolution === true &&
      from === ConversationStatus.RESOLVED &&
      to === ConversationStatus.OPEN &&
      options.actor !== 'system' &&
      (await this.retractResolvedLine(
        tx,
        storeId,
        conversationId,
        current.resolvedAt,
        options.actor.userId
      ))
    const event = undid ? null : systemEventFor(from, to, options.undoesResolution === true)
    const { afterTransition } = options
    if (afterTransition !== undefined) {
      this.prisma.afterCommit(tx, () => afterTransition({ from, to, retracted: undid }))
    }
    if (event !== null) {
      await writeSystemLine(tx, storeId, conversationId, {
        event,
        actor: actorRef(options.actor),
        causedBy: options.causedBy ?? null,
        from,
        to,
        reason: options.reason ?? options.resolutionReason ?? null,
        snoozedUntil: options.snoozedUntil?.toISOString() ?? null,
        // The reminder comes back on the line of waking, however it woke
        note: from === ConversationStatus.SNOOZED ? current.snoozeNote : null
      })
    }
    if (marks || (clearsMark && current.attentionReason !== null)) {
      this.events.publish(tx, Events.CONVERSATION_ATTENTION_CHANGED, {
        storeId,
        conversationId,
        reason: marks ? AttentionReasons.SNOOZE_WOKE : null,
        visibility: { hidden: isHiddenStatus(to), assignedTo: current.assignedTo }
      })
    }
    this.events.publish(tx, Events.CONVERSATION_STATUS_CHANGED, {
      storeId,
      conversationId,
      previousStatus: from,
      status: to,
      assignedTo: current.assignedTo,
      changedBy:
        options.causedBy === undefined ? actorRef(options.actor) : userRef(options.causedBy)
    })
    // A resolved or archived conversation that works again. A snoozed or pending one waking is not a
    // reopening: the snooze has its own event and the pending wait ends by itself
    if (
      to === ConversationStatus.OPEN &&
      (from === ConversationStatus.RESOLVED || from === ConversationStatus.ARCHIVED)
    ) {
      this.events.publish(tx, Events.CONVERSATION_REOPENED, {
        storeId,
        conversationId,
        assignedTo: current.assignedTo,
        reason: options.reason ?? null,
        reopenedBy:
          options.causedBy === undefined ? actorRef(options.actor) : userRef(options.causedBy)
      })
    }
    if (woke) {
      this.events.publish(tx, Events.CONVERSATION_SNOOZE_EXPIRED, {
        storeId,
        conversationId,
        assignedTo: current.assignedTo
      })
    }
  }

  // The line "resolved" of the resolution that the person is undoing, taken off the thread with the event
  // that tells the screens; false when the Undo is out of its window or the line is not theirs, which
  // leaves the thread as it is and lets the reopening write its line.
  private async retractResolvedLine(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    resolvedAt: Date | null,
    userId: string
  ): Promise<boolean> {
    if (resolvedAt === null) return false
    if (
      Date.now() - resolvedAt.getTime() >
      ResolveUndo.DURATION_MS + ResolveUndo.CLOSING_GRACE_MS
    ) {
      return false
    }
    const line = await tx.message.findFirst({
      where: {
        storeId,
        conversationId,
        type: MessageType.SYSTEM,
        metadata: { path: ['event'], equals: SystemMessageEvents.RESOLVED }
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, metadata: true, createdAt: true }
    })
    const parsed = systemLineMetadataSchema.safeParse(line?.metadata)
    if (line === null || !parsed.success) return false
    // The line of THIS resolution: written in the transaction that set `resolvedAt`, a moment apart at most
    if (Math.abs(line.createdAt.getTime() - resolvedAt.getTime()) > ResolveUndo.CLOSING_GRACE_MS) {
      return false
    }
    if (parsed.data.actor.type !== 'user' || parsed.data.actor.id !== userId) return false
    await lockMessageRow(tx, line.id)
    await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, line.id)
    await tx.message.delete({ where: { id: line.id } })
    return true
  }

  // Under the lock of the conversation, the one the worker takes to claim the message: a closing message
  // still queued and not marked as in flight is deleted at once, with the event that takes it off the
  // thread, so that the Undo does not leave it on screen until the worker finds it. The row is locked
  // and read again before it goes, after the conversation (the order of every writer).
  private async withdrawQueuedClosing(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    resolvedAt: Date | null,
    // The person who undoes: only the message they queued is theirs to take back. Null for the system.
    undoneBy: string | null
  ): Promise<void> {
    if (resolvedAt === null) return
    const queued = await tx.message.findMany({
      where: {
        storeId,
        conversationId,
        deliveryStatus: DeliveryStatus.QUEUED,
        failureDefinitive: null,
        createdAt: { gte: resolvedAt },
        ...(undoneBy === null ? {} : { authorId: undoneBy })
      },
      select: { id: true, metadata: true }
    })
    for (const { id, metadata } of queued) {
      if (!isClosingMessage(metadata)) continue
      await lockMessageRow(tx, id)
      const standing = await tx.message.count({
        where: { id, storeId, deliveryStatus: DeliveryStatus.QUEUED, failureDefinitive: null }
      })
      if (standing === 0) continue
      // The event reads the row, so it is made before the row goes
      await publishMessageChanged(this.events, tx, Events.MESSAGE_DELETED, storeId, id)
      await tx.message.delete({ where: { id } })
    }
  }

  // Gives a conversation nobody has to someone, atomically: a person who took it a moment earlier
  // keeps it, and one that was archived or marked as spam meanwhile is not given to someone who could
  // not see it. For the routing of a new conversation, which must not take one back, for the round robin
  // of a bulk action (whose actor is the person who asked) and for the first reply of an agent who may
  // assign. It never changes hands a conversation that has an owner.
  async assignIfFree(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    userId: string,
    actor: ConversationActor = 'system',
    // Why, when the system does it on the action of the person (the first reply)
    reason?: AssignmentReason
  ): Promise<boolean> {
    const { count } = await tx.conversation.updateMany({
      where: {
        id: conversationId,
        storeId,
        assignedTo: null,
        status: { notIn: [...ConversationHiddenStatuses] }
      },
      data: { assignedTo: userId }
    })
    if (count === 1) {
      await writeSystemLine(tx, storeId, conversationId, {
        event: SystemMessageEvents.ASSIGNED,
        actor: actorRef(actor),
        assignedTo: userId,
        ...(reason === undefined ? {} : { reason })
      })
      this.events.publish(tx, Events.CONVERSATION_ASSIGNED, {
        storeId,
        conversationId,
        assignedTo: userId,
        previousAssignee: null,
        assignedBy: actorRef(actor),
        // The update above refuses a hidden conversation
        visibility: { hidden: false, assignedTo: userId }
      })
    }
    return count === 1
  }

  // What a reply of an agent leaves in the conversation: the newest message of the thread (for the
  // list), the last answer, and the first answer once (TDD_11 section 7.2 reads it for the response
  // time). The dates never move back: a message that arrives late from a channel is older than one
  // written meanwhile. The reply of an automation (a plugin writing as the system) is not the answer of
  // a person: it sets firstAutomatedResponseAt and leaves firstResponseAt alone, so the response time
  // of the team never looks instant because a bot answered.
  async recordReply(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    at: Date,
    options: { automated?: boolean } = {}
  ): Promise<void> {
    // Three conditional writes, each atomic by itself: the dates stay right even for a caller that
    // does not hold the row lock
    const where = { id: conversationId, storeId }
    await this.recordMessageAt(tx, storeId, conversationId, at)
    await tx.conversation.updateMany({
      where: { ...where, OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: at } }] },
      data: { lastOutboundAt: at }
    })
    if (options.automated === true) {
      await tx.conversation.updateMany({
        where: { ...where, firstAutomatedResponseAt: null },
        data: { firstAutomatedResponseAt: at }
      })
      return
    }
    await tx.conversation.updateMany({
      where: { ...where, firstResponseAt: null },
      data: { firstResponseAt: at }
    })
  }

  // What a message of the customer leaves in the conversation: it is the newest message of the thread
  // (for the list), one more unread, and the last time the customer wrote. The dates never move back:
  // a message that arrives late is older than one that came meanwhile. The first answer and the last
  // outbound date are the agent's, set by recordReply.
  async recordInbound(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    at: Date
  ): Promise<void> {
    const where = { id: conversationId, storeId }
    await tx.conversation.updateMany({
      where: { ...where, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] },
      data: { lastMessageAt: at }
    })
    await tx.conversation.updateMany({
      where: { ...where, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
      data: { lastInboundAt: at }
    })
    await tx.conversation.updateMany({ where, data: { unreadCount: { increment: 1 } } })
  }

  // A message the customer did not write (the owner's, from the provider's app) moves the thread up the
  // inbox, and nothing else: it is not unread, and it does not answer the customer's wait
  async recordMessageAt(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    at: Date
  ): Promise<void> {
    await tx.conversation.updateMany({
      where: {
        id: conversationId,
        storeId,
        OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }]
      },
      data: { lastMessageAt: at }
    })
  }

  snooze(
    storeId: string,
    conversationId: string,
    until: Date,
    viewer: Viewer,
    note: string | null = null
  ): Promise<ConversationDetail> {
    assertSnoozeWindow(until)
    return this.updateStatus(storeId, conversationId, ConversationStatus.SNOOZED, {
      actor: viewer,
      snoozedUntil: until,
      snoozeNote: note
    })
  }

  // Taking a conversation, giving it to someone and releasing it. Two agents who take the same one
  // together take turns on the lock of the row: the second finds it assigned and is told to whom.
  // Only who may assign (CONVERSATIONS_ASSIGN) takes it from someone else or hands it over.
  async assign(
    storeId: string,
    conversationId: string,
    userId: string | null,
    viewer: Viewer
  ): Promise<ConversationDetail> {
    const { held } = viewer
    requireAnyPermission(held, [
      Permissions.CONVERSATIONS_RESOLVE,
      Permissions.CONVERSATIONS_ASSIGN
    ])
    const mayAssign = held.includes(Permissions.CONVERSATIONS_ASSIGN)
    // Whose membership is looked at first only when the caller may give the conversation to them
    const checksAssignee = userId !== null && (userId === viewer.userId || mayAssign)
    return this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      // The membership before the conversation, as removing a member does (it locks the membership
      // and then unassigns): the two never wait for each other in opposite orders
      if (checksAssignee) await this.requireAssignee(tx, storeId, userId)
      // Locked without the viewer: whoever loses a race for a conversation must be told that it is
      // taken (and by whom), not that it does not exist
      const current = await lockConversationForWrite(tx, storeId, conversationId)
      const visible = canSee(viewer, current)
      // The one thing that is answered about a conversation the caller does not see is that it is
      // taken, and only when they asked to take it
      if (!visible && !(userId === viewer.userId && !isHiddenStatus(current.status))) {
        throw resourceNotFound('conversation')
      }
      if (userId !== current.assignedTo) {
        if (userId === viewer.userId) {
          if (current.assignedTo !== null && !mayAssign) {
            throw resourceConflict('the conversation is assigned to someone else', {
              assignedTo: current.assignedTo
            })
          }
        } else if (userId === null) {
          if (current.assignedTo !== viewer.userId) {
            requireAnyPermission(held, [Permissions.CONVERSATIONS_ASSIGN])
          }
        } else {
          requireAnyPermission(held, [Permissions.CONVERSATIONS_ASSIGN])
        }
        // Whoever gets an archived or spam conversation could not see it unless they may archive
        if (userId !== null && isHiddenStatus(current.status)) {
          throw resourceConflict(
            'an archived or spam conversation is reopened before it is assigned'
          )
        }
        await tx.conversation.update({
          where: { id: conversationId, storeId },
          data: { assignedTo: userId }
        })
        await writeSystemLine(tx, storeId, conversationId, {
          event: userId === null ? SystemMessageEvents.UNASSIGNED : SystemMessageEvents.ASSIGNED,
          actor: actorRef(viewer),
          assignedTo: userId,
          previousAssignee: current.assignedTo
        })
        this.events.publish(tx, Events.CONVERSATION_ASSIGNED, {
          storeId,
          conversationId,
          assignedTo: userId,
          previousAssignee: current.assignedTo,
          assignedBy: actorRef(viewer),
          visibility: { hidden: isHiddenStatus(current.status), assignedTo: userId }
        })
      }
      // Read inside the lock, and without hiding it from the one who asked: handing a conversation
      // over takes it out of their sight, and the change they were allowed to make must not answer
      // as if it had not happened
      return this.detail(tx, storeId, conversationId, viewer, true)
    })
  }

  // Opening the thread. The unread count and who read it last are the conversation's, not the user's.
  async markRead(
    storeId: string,
    conversationId: string,
    viewer: Viewer
  ): Promise<ConversationDetail> {
    return this.prisma.transaction(async tx => {
      const current = await lockConversationForWrite(tx, storeId, conversationId, viewer)
      // Opening it takes the mark of attention off, for everyone: it asked for a look and got one
      const marked = current.attentionReason !== null
      await tx.conversation.update({
        where: { id: conversationId, storeId },
        data: {
          unreadCount: 0,
          lastReadAt: new Date(),
          lastReadBy: viewer.userId,
          ...(marked ? { attentionReason: null, attentionAt: null, attentionNote: null } : {})
        }
      })
      if (marked) {
        this.events.publish(tx, Events.CONVERSATION_ATTENTION_CHANGED, {
          storeId,
          conversationId,
          reason: null,
          visibility: { hidden: isHiddenStatus(current.status), assignedTo: current.assignedTo }
        })
      }
      this.events.publish(tx, Events.CONVERSATION_READ, {
        storeId,
        conversationId,
        userId: viewer.userId,
        visibility: { hidden: isHiddenStatus(current.status), assignedTo: current.assignedTo }
      })
      return this.detail(tx, storeId, conversationId, viewer, true)
    })
  }

  // The inverse of opening the thread, from the menu or the keyboard: the conversation counts as unread
  // again, which is how an agent keeps one to come back to. `lastReadAt` goes just before the last
  // message of the customer, as TDD_09 §3.1 says. A conversation the customer never wrote in has
  // nothing to mark.
  async markUnread(
    storeId: string,
    conversationId: string,
    viewer: Viewer
  ): Promise<ConversationDetail> {
    return this.prisma.transaction(async tx => {
      const current = await lockConversationForWrite(tx, storeId, conversationId, viewer)
      const { lastInboundAt, unreadCount } = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId, storeId },
        select: { lastInboundAt: true, unreadCount: true }
      })
      if (lastInboundAt === null) {
        throw resourceConflict('the customer has not written in this conversation')
      }
      await tx.conversation.update({
        where: { id: conversationId, storeId },
        data: {
          unreadCount: Math.max(unreadCount, 1),
          lastReadAt: new Date(lastInboundAt.getTime() - 1),
          lastReadBy: null
        }
      })
      this.events.publish(tx, Events.CONVERSATION_UNREAD, {
        storeId,
        conversationId,
        userId: viewer.userId,
        visibility: { hidden: isHiddenStatus(current.status), assignedTo: current.assignedTo }
      })
      return this.detail(tx, storeId, conversationId, viewer, true)
    })
  }

  private async detail(
    db: PrismaService['client'],
    storeId: string,
    conversationId: string,
    viewer?: Viewer,
    // After a change the caller was allowed to make, the answer is not hidden from them even if the
    // change took the conversation out of their sight; what they may read of it still applies
    revealed = false
  ): Promise<ConversationDetail> {
    const row = await db.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: DETAIL_SELECT
    })
    if (row === null || (!revealed && !canSee(viewer, row))) throw resourceNotFound('conversation')
    const [item] = await listItemsOf(db, storeId, [row], viewer)
    if (item === undefined) throw resourceNotFound('conversation')
    return {
      ...item,
      channelConnectionId: row.channelConnectionId,
      lastInboundAt: row.lastInboundAt,
      lastReadAt: row.lastReadAt,
      resolvedAt: row.resolvedAt,
      resolutionReason: row.resolutionReason,
      createdAt: row.createdAt
    }
  }

  // The customer to put the conversation on: the one asked for, or the one it was merged into. The
  // chain is followed with plain reads and only the last customer is locked (FOR KEY SHARE, then read
  // again): a merge or an unmerge locks the survivor first and the absorbed one after, and holding the
  // absorbed one while waiting for the survivor would be the opposite order.
  private async survivorOf(
    tx: PrismaTransaction,
    storeId: string,
    customerId: string
  ): Promise<string> {
    let id = customerId
    for (let hop = 0; hop <= MAX_MERGE_HOPS; hop += 1) {
      const seen = await tx.customer.findFirst({
        where: { id, storeId },
        select: { mergedIntoId: true }
      })
      if (seen === null) throw resourceNotFound('customer')
      if (seen.mergedIntoId !== null) {
        id = seen.mergedIntoId
        continue
      }
      const rows = await tx.$queryRaw<{ merged_into_id: string | null }[]>`
        SELECT merged_into_id FROM customers
        WHERE id = ${id} AND store_id = ${storeId}
        FOR KEY SHARE`
      const locked = rows[0]
      if (locked === undefined) throw resourceNotFound('customer')
      // Merged while it was being locked: the chain goes on from there
      if (locked.merged_into_id === null) return id
      id = locked.merged_into_id
    }
    throw resourceConflict('the customer was merged too many times to follow')
  }

  // Someone who belongs to the store now and may see its conversations. The membership is locked
  // shared until the commit: removing a member takes the row for update, so one of the two comes
  // first and the other sees what it left (a removed member is not given a conversation).
  private async requireAssignee(
    tx: PrismaTransaction,
    storeId: string,
    userId: string
  ): Promise<void> {
    if (!(await this.assigneeCanWork(tx, storeId, userId))) throw resourceNotFound('assignee')
  }

  // Whether the person is an active member who can open conversations and answer them, with their
  // membership held `FOR SHARE` until the end of the transaction (a suspension waits for it). It takes
  // the membership BEFORE the conversation, as `assign` does and as removing a member does: a caller
  // that locks a conversation first must ask this first.
  async assigneeCanWork(tx: PrismaTransaction, storeId: string, userId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ role_id: string }[]>`
      SELECT role_id FROM memberships
      WHERE store_id = ${storeId} AND user_id = ${userId}
        AND status = ${MembershipStatus.ACTIVE} AND revoked_at IS NULL
      FOR SHARE`
    const roleId = rows[0]?.role_id
    if (roleId === undefined) return false
    const held = await tx.permission.count({
      where: { roleId, name: { in: [...AssigneePermissions] } }
    })
    return held === AssigneePermissions.length
  }
}

function userRef(userId: string): ActorRef {
  return { type: 'user', id: userId }
}

function actorRef(actor: ConversationActor): ActorRef {
  return actor === 'system' ? { type: 'system', id: null } : userRef(actor.userId)
}

// The fields that go with a status, besides the status itself. Only reopening clears anything: the
// machine leaves a snoozed conversation only to OPEN, so no other destination has one to clear.
function fieldsOf(to: ConversationStatus, options: StatusOptions) {
  switch (to) {
    case ConversationStatus.OPEN:
      return { resolvedAt: null, resolutionReason: null, archivedAt: null, snoozedUntil: null }
    case ConversationStatus.PENDING:
    case ConversationStatus.SPAM:
      return {}
    case ConversationStatus.RESOLVED:
      return { resolvedAt: new Date(), resolutionReason: options.resolutionReason ?? null }
    case ConversationStatus.ARCHIVED:
      return { archivedAt: new Date() }
    case ConversationStatus.SNOOZED:
      return { snoozedUntil: options.snoozedUntil ?? null, snoozeNote: options.snoozeNote ?? null }
  }
}
