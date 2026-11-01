import { Permissions } from '@platform/core/auth'
import { MediaStatus, ConversationHiddenStatuses } from '@platform/core/domain'
import { galleryContentTypes, type GalleryType, GalleryTypes } from '@platform/core/storage'

import { visibleTo, type Viewer } from '../conversations/conversations.support'
import { escapeLike } from '../customers/customers.support'

interface ConversationScope {
  OR?: { assignedTo: string | null }[]
  status?: { notIn: string[] }
}

export interface MediaGalleryWhere {
  storeId: string
  customerId: string
  status: string
  contentType?: { in: string[] }
  filename?: { contains: string; mode: 'insensitive' }
  message?: { is: { conversation: { is: ConversationScope } } }
  id?: { in: string[] }
}

// The files of a customer a member may be offered: of this store, clean (a file not scanned yet is
// not offered, an infected one never) and sent by or to the customer. Shared by the gallery and by
// the ZIP, so the file holds what the gallery showed.
//
// With a `viewer`, only the files of conversations the viewer could open in the inbox: the same rule
// as the list (`visibleTo`, nothing archived or spam without CONVERSATIONS_ARCHIVE). Who may not see
// conversations at all sees no file, and a file with no message is shown only to who sees it all.
export function mediaGalleryWhere(
  storeId: string,
  customerId: string,
  filter: { type?: GalleryType | undefined; q?: string | undefined },
  viewer?: Viewer
): MediaGalleryWhere {
  const contentTypes = galleryContentTypes(filter.type ?? GalleryTypes.ALL)
  return {
    storeId,
    customerId,
    status: MediaStatus.CLEAN,
    ...(contentTypes === null ? {} : { contentType: { in: [...contentTypes] } }),
    ...(filter.q === undefined
      ? {}
      : { filename: { contains: escapeLike(filter.q), mode: 'insensitive' as const } }),
    ...(viewer === undefined ? {} : scopeOf(viewer))
  }
}

function scopeOf(viewer: Viewer): Pick<MediaGalleryWhere, 'message' | 'id'> {
  if (!viewer.held.includes(Permissions.CONVERSATIONS_VIEW)) return { id: { in: [] } }
  const seesHidden = viewer.held.includes(Permissions.CONVERSATIONS_ARCHIVE)
  if (viewer.canViewAll && seesHidden) return {}
  return {
    message: {
      is: {
        conversation: {
          is: {
            ...visibleTo(viewer),
            ...(seesHidden ? {} : { status: { notIn: [...ConversationHiddenStatuses] } })
          }
        }
      }
    }
  }
}
