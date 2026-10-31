import { Injectable } from '@nestjs/common'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  ConversationHiddenStatuses,
  type CursorPage,
  type CustomerTimelineType,
  CustomerTimelineTypes
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { visibleTo, type Viewer } from '@platform/core/messaging'

import type { ListTimelineQuery } from './customers.schemas'
import { encodeCursor } from './list-cursor'

export interface ConversationTimelineEntry {
  type: typeof CustomerTimelineTypes.CONVERSATION
  id: string
  at: Date
  channelType: string
  status: string
}

export interface NoteTimelineEntry {
  type: typeof CustomerTimelineTypes.NOTE
  id: string
  at: Date
  authorId: string
  authorName: string | null
  content: string
}

export interface MergeTimelineEntry {
  type: typeof CustomerTimelineTypes.MERGE
  id: string
  at: Date
  absorbedId: string
  mergedById: string
  mergedByName: string | null
  unmergeUntil: Date
  unmergedAt: Date | null
}

export type TimelineEntry = ConversationTimelineEntry | NoteTimelineEntry | MergeTimelineEntry
export type TimelinePage = CursorPage<TimelineEntry>

const wants = (query: ListTimelineQuery, type: CustomerTimelineType): boolean =>
  query.type === undefined || query.type === type

// The activity of a customer, the newest first, from the tables that hold it: one query for each,
// each cut to a page past the cursor, merged by (date, id). What a viewer may not see is not here:
// a conversation follows the visibility of the inbox, and the notes and merges need the permissions
// of their own routes.
@Injectable()
export class CustomerTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    storeId: string,
    customerId: string,
    query: ListTimelineQuery,
    viewer: Viewer
  ): Promise<TimelinePage> {
    await this.requireCustomer(storeId, customerId)
    const { cursor, limit } = query
    // Strictly after the last entry of the previous page in (date, id) order
    const before = (field: string) =>
      cursor === undefined
        ? {}
        : {
            OR: [
              { [field]: { lt: cursor.createdAt } },
              { [field]: cursor.createdAt, id: { lt: cursor.id } }
            ]
          }
    const take = limit + 1
    const seesConversations = viewer.held.includes(Permissions.CONVERSATIONS_VIEW)
    const seesHidden = viewer.held.includes(Permissions.CONVERSATIONS_ARCHIVE)

    const [conversations, notes, merges] = await Promise.all([
      wants(query, CustomerTimelineTypes.CONVERSATION) && seesConversations
        ? this.prisma.client.conversation.findMany({
            where: {
              storeId,
              customerId,
              ...(seesHidden ? {} : { status: { notIn: [...ConversationHiddenStatuses] } }),
              AND: [visibleTo(viewer), before('createdAt')]
            },
            select: { id: true, createdAt: true, channelType: true, status: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take
          })
        : [],
      wants(query, CustomerTimelineTypes.NOTE)
        ? this.prisma.client.customerNote.findMany({
            where: { customerId, ...before('createdAt') },
            select: { id: true, createdAt: true, authorId: true, content: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take
          })
        : [],
      wants(query, CustomerTimelineTypes.MERGE)
        ? this.prisma.client.customerMerge.findMany({
            where: { storeId, survivorId: customerId, ...before('mergedAt') },
            select: {
              id: true,
              mergedAt: true,
              absorbedId: true,
              mergedById: true,
              unmergeUntil: true,
              unmergedAt: true
            },
            orderBy: [{ mergedAt: 'desc' }, { id: 'desc' }],
            take
          })
        : []
    ])

    const names = await this.namesOf(storeId, [
      ...notes.map(note => note.authorId),
      ...merges.map(merge => merge.mergedById)
    ])
    const entries: TimelineEntry[] = [
      ...conversations.map((row): ConversationTimelineEntry => ({
        type: CustomerTimelineTypes.CONVERSATION,
        id: row.id,
        at: row.createdAt,
        channelType: row.channelType,
        status: row.status
      })),
      ...notes.map((row): NoteTimelineEntry => ({
        type: CustomerTimelineTypes.NOTE,
        id: row.id,
        at: row.createdAt,
        authorId: row.authorId,
        authorName: names.get(row.authorId) ?? null,
        content: row.content
      })),
      ...merges.map((row): MergeTimelineEntry => ({
        type: CustomerTimelineTypes.MERGE,
        id: row.id,
        at: row.mergedAt,
        absorbedId: row.absorbedId,
        mergedById: row.mergedById,
        mergedByName: names.get(row.mergedById) ?? null,
        unmergeUntil: row.unmergeUntil,
        unmergedAt: row.unmergedAt
      }))
    ].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))

    const hasMore = entries.length > limit
    const page = hasMore ? entries.slice(0, limit) : entries
    const last = page.at(-1)
    return {
      data: page,
      nextCursor:
        hasMore && last !== undefined ? encodeCursor({ createdAt: last.at, id: last.id }) : null,
      hasMore
    }
  }

  // 404 for a customer that is not in the store, or was absorbed by a merge
  async requireCustomer(storeId: string, customerId: string): Promise<void> {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: customerId, storeId, mergedIntoId: null },
      select: { id: true }
    })
    if (customer === null) throw resourceNotFound('customer')
  }

  // The names of people of this store (the members): a user outside it is not named
  private async namesOf(storeId: string, userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map()
    const rows = await this.prisma.client.membership.findMany({
      where: { storeId, userId: { in: [...new Set(userIds)] } },
      select: { userId: true, user: { select: { name: true } } }
    })
    return new Map(rows.map(row => [row.userId, row.user.name]))
  }
}
