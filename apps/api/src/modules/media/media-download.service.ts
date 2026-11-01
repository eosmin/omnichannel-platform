import { Injectable } from '@nestjs/common'

import type { Permission } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { mediaGalleryWhere, viewerOf, viewPermissionsOf } from '@platform/core/messaging'
import { ExportFormats, ExportTypes } from '@platform/core/queues'
import { type DownloadAllBody, GalleryLimits } from '@platform/core/storage'

import { ExportsService, type ExportView } from '../exports'

// "Download all" of the gallery of a customer (TDD_09 §7): the files the gallery shows under the
// same tab and search, as one ZIP made in the background. The answer is the export to follow in the
// exports center.
@Injectable()
export class MediaDownloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ExportsService
  ) {}

  async requestZip(
    storeId: string,
    userId: string,
    held: readonly Permission[],
    body: DownloadAllBody
  ): Promise<ExportView> {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: body.customerId, storeId, mergedIntoId: null },
      select: { id: true }
    })
    if (customer === null) throw resourceNotFound('customer')

    // Refused now, with its reason, and not an hour later as a failed export. The worker checks the
    // same ceilings again, because the files can grow between the request and the ZIP.
    const total = await this.prisma.client.media.aggregate({
      where: mediaGalleryWhere(storeId, body.customerId, body, viewerOf(userId, held)),
      _count: { _all: true },
      _sum: { fileSize: true }
    })
    const files = total._count._all
    if (files === 0) {
      throw new PlatformException(
        ErrorCodes.EXPORT_EMPTY,
        'there are no files to download',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    if (
      files > GalleryLimits.ZIP_MAX_FILES ||
      (total._sum.fileSize ?? 0) > GalleryLimits.ZIP_MAX_BYTES
    ) {
      throw new PlatformException(
        ErrorCodes.EXPORT_TOO_LARGE,
        'the files are too many or too large for one download',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    return this.exports.request({
      storeId,
      userId,
      type: ExportTypes.MEDIA_ZIP,
      format: ExportFormats.ZIP,
      filters: {
        customerId: body.customerId,
        ...(body.type === undefined ? {} : { type: body.type }),
        ...(body.q === undefined ? {} : { q: body.q }),
        // The file holds what the requester could see now: their permissions are frozen in the row
        viewer: { userId, held: viewPermissionsOf(held) }
      }
    })
  }
}
