import {
  AuthorType,
  ChannelConnectionStatus,
  ChannelIds,
  DeliveryStatus,
  MediaStatus,
  MessageType,
  type WidgetAuthor,
  WidgetAuthors
} from '@platform/core/domain'
import { MediaPurpose } from '@platform/core/storage'

// A file of a message as the visitor sees it. The link is never here: it is asked from the download
// route when the visitor opens the file, so that it is fresh and signed for them.
export interface WidgetAttachmentView {
  id: string
  filename: string
  contentType: string
  size: number
}

// A message as the visitor sees it: who (their side or the store's), what, and when. Nothing about the
// agents or the conversation leaves. `content` is the text, or the caption of the files, and is empty
// when the message is only files; `attachments` is empty for a text message.
export interface WidgetMessageView {
  id: string
  from: WidgetAuthor
  content: string
  attachments: WidgetAttachmentView[]
  createdAt: string
}

// The kinds of message a visitor can be shown: text and files. A note, a system line and the rest of
// the kinds a channel never carries stay with the team.
export const WIDGET_VISIBLE_TYPES = [
  MessageType.TEXT,
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
] as const

// The files of a message that a visitor may be given: a file of the message itself (not the picture of
// an ad) that the scan found clean
export const WIDGET_FILES_SELECT = {
  where: { purpose: MediaPurpose.MESSAGE, status: MediaStatus.CLEAN },
  select: { id: true, filename: true, contentType: true, fileSize: true },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
}

export interface VisitorMessagesWhere {
  storeId: string
  type: { in: MessageType[] }
  deletedAt: null
  conversation: {
    channelConnectionId: string
    customerIdentity: { channelType: string; channelIdentity: string }
  }
  OR: ({ authorType: string } | { deliveryStatus: { in: string[] } })[]
}

// Which messages of a visitor's conversation on this widget a visitor may read: what they wrote, and
// what the store sent that the channel has taken (not a reply still waiting, one that failed, or a
// deleted message). Shared by the history, the live delivery check and the download of a file, so the
// three can never disagree about what is theirs.
export function visitorMessagesWhere(
  site: { storeId: string; connectionId: string },
  visitorId: string
): VisitorMessagesWhere {
  return {
    storeId: site.storeId,
    type: { in: [...WIDGET_VISIBLE_TYPES] },
    deletedAt: null,
    conversation: {
      channelConnectionId: site.connectionId,
      customerIdentity: { channelType: ChannelIds.WEB_WIDGET, channelIdentity: visitorId }
    },
    OR: [
      { authorType: AuthorType.CUSTOMER },
      {
        deliveryStatus: {
          in: [DeliveryStatus.SENT, DeliveryStatus.DELIVERED, DeliveryStatus.READ]
        }
      }
    ]
  }
}

// A reply the live delivery may push: it comes from the team, on an active widget connection
export const LIVE_DELIVERY_CONNECTION = {
  pluginId: ChannelIds.WEB_WIDGET,
  status: ChannelConnectionStatus.ACTIVE
} as const

interface MessageRow {
  id: string
  content: string | null
  authorType: string
  createdAt: Date
  media: { id: string; filename: string; contentType: string; fileSize: number }[]
}

// A message with neither text nor a file the visitor can have yet (a file still being scanned, or an
// infected one) has nothing to show
export function widgetMessageView(row: MessageRow): WidgetMessageView | null {
  if (row.content === null && row.media.length === 0) return null
  return {
    id: row.id,
    from:
      row.authorType === String(AuthorType.CUSTOMER) ? WidgetAuthors.VISITOR : WidgetAuthors.TEAM,
    content: row.content ?? '',
    attachments: row.media.map(file => ({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.fileSize
    })),
    createdAt: row.createdAt.toISOString()
  }
}
