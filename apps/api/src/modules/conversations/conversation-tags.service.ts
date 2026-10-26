import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { ConversationLimits } from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import { lockConversationForWrite, type Viewer } from './conversations.support'

export interface ConversationTag {
  id: string
  name: string
  color: string
}

const TAG_SELECT = { id: true, name: true, color: true } as const

// The tags of a conversation are the tags of the store (the ones the customers use too)
@Injectable()
export class ConversationTagsService {
  constructor(private readonly prisma: PrismaService) {}

  // Attaching a tag the conversation already has changes nothing
  attach(
    storeId: string,
    conversationId: string,
    tagId: string,
    viewer: Viewer
  ): Promise<ConversationTag[]> {
    return this.prisma.transaction(async tx => {
      await lockConversationForWrite(tx, storeId, conversationId, viewer)
      // A tag of another store is a tag that does not exist. It is held while the link is written:
      // deleting a tag takes the row for update, so it waits for this or is waited for.
      const tags = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM tags WHERE id = ${tagId} AND store_id = ${storeId} FOR KEY SHARE`
      if (tags.length === 0) throw resourceNotFound('tag')
      const held = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId, storeId },
        select: { tags: { select: { id: true } } }
      })
      if (
        !held.tags.some(tag => tag.id === tagId) &&
        held.tags.length >= ConversationLimits.MAX_TAGS_PER_CONVERSATION
      ) {
        throw resourceConflict(
          `a conversation holds at most ${ConversationLimits.MAX_TAGS_PER_CONVERSATION} tags`,
          { limit: ConversationLimits.MAX_TAGS_PER_CONVERSATION }
        )
      }
      const row = await tx.conversation.update({
        where: { id: conversationId, storeId },
        data: { tags: { connect: { id: tagId } } },
        select: { tags: { select: TAG_SELECT, orderBy: { name: 'asc' } } }
      })
      return row.tags
    })
  }

  async detach(
    storeId: string,
    conversationId: string,
    tagId: string,
    viewer: Viewer
  ): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockConversationForWrite(tx, storeId, conversationId, viewer)
      const tag = await tx.tag.findFirst({ where: { id: tagId, storeId }, select: { id: true } })
      if (tag === null) throw resourceNotFound('tag')
      await tx.conversation.update({
        where: { id: conversationId, storeId },
        data: { tags: { disconnect: { id: tagId } } }
      })
    })
  }
}
