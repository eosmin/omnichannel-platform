import { Injectable } from '@nestjs/common'

import { type Permission, Permissions } from '@platform/core/auth'
import { lockStoreForWrite, PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  ConversationAssignedFilters,
  ConversationHiddenStatuses,
  ConversationLimits,
  ConversationStatus,
  ConversationStatusTransitions,
  MembershipStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import { encodeConversationCursor } from './conversation-cursor'
import type { ListConversationsQuery } from './conversations.schemas'
import {
  canSee,
  type ConversationActor,
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

export interface StatusOptions {
  actor: ConversationActor
  resolutionReason?: string
  // Required to snooze: the moment the conversation comes back
  snoozedUntil?: Date
}

export interface NewConversation {
  customerId: string
  customerIdentityId: string
  channelConnectionId: string
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  // Called by the inbound pipeline (Step 2.6), not by a route: a conversation starts with a message
  // from a channel. The customer is locked FOR KEY SHARE and read again, because a merge may have
  // absorbed it a moment ago: the conversation goes to the survivor (MVP_TRIM_CHECKLIST item 27).
  async create(storeId: string, input: NewConversation): Promise<ConversationDetail> {
    const id = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const customerId = await this.survivorOf(tx, storeId, input.customerId)
      const identity = await tx.customerIdentity.findFirst({
        where: { id: input.customerIdentityId, storeId, customerId },
        select: { id: true, channelType: true }
      })
      if (identity === null) throw resourceNotFound('customer identity')
      const connection = await tx.channelConnection.findFirst({
        where: { id: input.channelConnectionId, storeId },
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
    })
    return this.get(storeId, id)
  }

  async list(
    storeId: string,
    query: ListConversationsQuery,
    viewer: Viewer
  ): Promise<ConversationPage> {
    const { cursor } = query
    // The history of what was archived or marked as spam is for who may archive
    if (query.status !== undefined && isHiddenStatus(query.status)) {
      requireAnyPermission(viewer.held, [Permissions.CONVERSATIONS_ARCHIVE])
    }
    const rows = await this.prisma.client.conversation.findMany({
      where: {
        storeId,
        status: query.status ?? { notIn: [...ConversationHiddenStatuses] },
        ...(query.channelType === undefined ? {} : { channelType: query.channelType }),
        ...(query.tagId === undefined ? {} : { tags: { some: { id: query.tagId } } }),
        AND: [
          visibleTo(viewer),
          assignedFilter(query.assigned, viewer),
          // After the last row of the previous page in (lastMessageAt desc, nulls last, id desc)
          cursor === undefined
            ? {}
            : cursor.lastMessageAt === null
              ? { lastMessageAt: null, id: { lt: cursor.id } }
              : {
                  OR: [
                    { lastMessageAt: { lt: cursor.lastMessageAt } },
                    { lastMessageAt: cursor.lastMessageAt, id: { lt: cursor.id } },
                    { lastMessageAt: null }
                  ]
                }
        ]
      },
      select: LIST_SELECT,
      take: query.limit + 1,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: await listItemsOf(this.prisma.client, storeId, page, viewer),
      nextCursor:
        hasMore && last !== undefined
          ? encodeConversationCursor({ lastMessageAt: last.lastMessageAt, id: last.id })
          : null,
      hasMore
    }
  }

  async get(storeId: string, conversationId: string, viewer?: Viewer): Promise<ConversationDetail> {
    return this.detail(this.prisma.client, storeId, conversationId, viewer)
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
    await tx.conversation.update({
      where: { id: conversationId, storeId },
      data: {
        // eslint-disable-next-line no-restricted-syntax -- the one place that writes the status
        status: to,
        ...fieldsOf(to, options)
      }
    })
  }

  // What a reply of an agent leaves in the conversation: the newest message of the thread (for the
  // list), the last answer, and the first answer once (TDD_11 section 7.2 reads it for the response
  // time). The dates never move back: a message that arrives late from a channel is older than one
  // written meanwhile.
  async recordReply(
    tx: PrismaTransaction,
    storeId: string,
    conversationId: string,
    at: Date
  ): Promise<void> {
    // Three conditional writes, each atomic by itself: the dates stay right even for a caller that
    // does not hold the row lock
    const where = { id: conversationId, storeId }
    await tx.conversation.updateMany({
      where: { ...where, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }] },
      data: { lastMessageAt: at }
    })
    await tx.conversation.updateMany({
      where: { ...where, OR: [{ lastOutboundAt: null }, { lastOutboundAt: { lt: at } }] },
      data: { lastOutboundAt: at }
    })
    await tx.conversation.updateMany({
      where: { ...where, firstResponseAt: null },
      data: { firstResponseAt: at }
    })
  }

  snooze(
    storeId: string,
    conversationId: string,
    until: Date,
    viewer: Viewer
  ): Promise<ConversationDetail> {
    assertSnoozeWindow(until)
    return this.updateStatus(storeId, conversationId, ConversationStatus.SNOOZED, {
      actor: viewer,
      snoozedUntil: until
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
      await lockConversationForWrite(tx, storeId, conversationId, viewer)
      await tx.conversation.update({
        where: { id: conversationId, storeId },
        data: { unreadCount: 0, lastReadAt: new Date(), lastReadBy: viewer.userId }
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
    const rows = await tx.$queryRaw<{ role_id: string }[]>`
      SELECT role_id FROM memberships
      WHERE store_id = ${storeId} AND user_id = ${userId}
        AND status = ${MembershipStatus.ACTIVE} AND revoked_at IS NULL
      FOR SHARE`
    const roleId = rows[0]?.role_id
    if (roleId === undefined) throw resourceNotFound('assignee')
    const sees = await tx.permission.count({
      where: { roleId, name: Permissions.CONVERSATIONS_VIEW }
    })
    if (sees === 0) throw resourceNotFound('assignee')
  }
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
      return { snoozedUntil: options.snoozedUntil ?? null }
  }
}

function assignedFilter(
  assigned: ListConversationsQuery['assigned'],
  viewer: Viewer
): { assignedTo?: string | null } {
  if (assigned === undefined) return {}
  if (assigned === ConversationAssignedFilters.UNASSIGNED) return { assignedTo: null }
  return { assignedTo: assigned === ConversationAssignedFilters.ME ? viewer.userId : assigned }
}
