import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import {
  ConversationLimits,
  httpUrl,
  InboundLimits,
  type OriginKind,
  OriginKinds,
  type OriginMediaType,
  OriginMediaTypes
} from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'
import { canSee, enumValueOf, type Viewer } from '@platform/core/messaging'

// What the origin card draws. The click id and the raw referral of the provider stay in the database:
// they are tracking data the interface has no use for.
export interface OriginView {
  id: string
  messageId: string
  kind: OriginKind
  sourceId: string | null
  sourceUrl: string | null
  title: string | null
  body: string | null
  mediaType: OriginMediaType | null
  mediaUrl: string | null
  thumbnailUrl: string | null
  createdAt: Date
}

// The links came from an ad: untrusted, drawn as a link or an image and never fetched here. They are
// checked again on the way out, so that anything that is not a plain http(s) link is no link.
const link = httpUrl(InboundLimits.MEDIA_REF_MAX_LENGTH)
const linkOrNull = (value: string | null): string | null => link.safeParse(value).data ?? null

const ORIGIN_SELECT = {
  id: true,
  messageId: true,
  kind: true,
  sourceId: true,
  sourceUrl: true,
  title: true,
  body: true,
  mediaType: true,
  mediaUrl: true,
  thumbnailUrl: true,
  createdAt: true
} as const

// The origins of a conversation, newest first: the thread shows the first one apart, as the first contact
@Injectable()
export class ConversationOriginsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(storeId: string, conversationId: string, viewer: Viewer): Promise<OriginView[]> {
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id: conversationId, storeId },
      select: { status: true, assignedTo: true }
    })
    // The same answer for a conversation that does not exist and one the viewer may not see
    if (conversation === null || !canSee(viewer, conversation)) {
      throw resourceNotFound('conversation')
    }
    const where = { storeId, conversationId }
    const rows = await this.prisma.client.conversationOrigin.findMany({
      where,
      select: ORIGIN_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ConversationLimits.MAX_ORIGINS_LISTED
    })
    // Past the cap the newest are kept, and the first contact is added: the card names it as such
    if (rows.length === ConversationLimits.MAX_ORIGINS_LISTED) {
      const first = await this.prisma.client.conversationOrigin.findFirst({
        where,
        select: ORIGIN_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
      if (first !== null && !rows.some(row => row.id === first.id)) rows.push(first)
    }
    return rows.map(row => ({
      ...row,
      kind: enumValueOf(OriginKinds, row.kind, 'origin kind'),
      mediaType:
        row.mediaType === null
          ? null
          : enumValueOf(OriginMediaTypes, row.mediaType, 'origin media'),
      sourceUrl: linkOrNull(row.sourceUrl),
      mediaUrl: linkOrNull(row.mediaUrl),
      thumbnailUrl: linkOrNull(row.thumbnailUrl)
    }))
  }
}
