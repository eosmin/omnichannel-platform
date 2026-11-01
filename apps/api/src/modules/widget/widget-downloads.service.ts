import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'
import { ImageVariants } from '@platform/core/storage'

import { MediaService } from '../media/media.service'

import { WIDGET_FILES_SELECT, visitorMessagesWhere } from './widget-message-view'
import type { WidgetSite } from './widget-sites.service'

// What the visitor is given to open a file: the download of the original, and the picture shown inline
// for an image (null for any other file)
export interface WidgetFileLink {
  url: string
  filename: string
  contentType: string
  previewUrl: string | null
}

// The files of a visitor's conversation (TDD_07 §6.6, TDD_10 §5.4). The visitor is anonymous and has
// no store header: the token names the site and the visitor, and a file is theirs only when it hangs
// from a message they may read (`visitorMessagesWhere`, the rule of the history). The link itself is
// signed by the same code as the inbox's, so a file that is not clean is never given (it is a 404 here first).
@Injectable()
export class WidgetDownloads {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService
  ) {}

  async linkFor(site: WidgetSite, visitorId: string, mediaId: string): Promise<WidgetFileLink> {
    // A file of another store, of another visitor, of a note, of a message that was deleted or never
    // reached the visitor, or one the scan has not cleared is the same answer as one that does not exist
    const owned = await this.prisma.client.media.findFirst({
      where: {
        id: mediaId,
        storeId: site.storeId,
        // The rule of the history: a file that is not clean is not theirs to ask for yet
        ...WIDGET_FILES_SELECT.where,
        message: visitorMessagesWhere(site, visitorId)
      },
      select: { id: true }
    })
    if (owned === null) throw resourceNotFound('widget file')
    const urls = await this.media.urlsFor(site.storeId, owned.id)
    return {
      url: urls.url,
      filename: urls.filename,
      contentType: urls.contentType,
      previewUrl: urls.variants[ImageVariants.MEDIUM]
    }
  }
}
