import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import {
  ConversationLimits,
  httpUrl,
  InboundLimits,
  MediaStatus,
  type OriginKind,
  OriginKinds,
  OriginMediaSlots,
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
  // The pictures the worker kept as files of the store: the card draws these, from a signed link, and
  // not the address of the ad, which expires and tells the ad's CDN who is looking. Null while there
  // is none, and for a file that was found infected.
  mediaFile: OriginFileView | null
  thumbnailFile: OriginFileView | null
  createdAt: Date
}

export interface OriginFileView {
  id: string
  // `pending` until the scan ends: the card asks again
  status: typeof MediaStatus.PENDING | typeof MediaStatus.CLEAN
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
    const files = await this.prisma.client.media.findMany({
      where: {
        storeId,
        originId: { in: rows.map(row => row.id) },
        status: { in: [MediaStatus.PENDING, MediaStatus.CLEAN] }
      },
      select: { id: true, originId: true, originSlot: true, status: true }
    })
    const fileOf = (originId: string, slot: string): OriginFileView | null => {
      const file = files.find(item => item.originId === originId && item.originSlot === slot)
      if (file === undefined) return null
      return {
        id: file.id,
        status: file.status === String(MediaStatus.CLEAN) ? MediaStatus.CLEAN : MediaStatus.PENDING
      }
    }
    return rows.map(row => ({
      ...row,
      mediaFile: fileOf(row.id, OriginMediaSlots.MEDIA),
      thumbnailFile: fileOf(row.id, OriginMediaSlots.THUMBNAIL),
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
