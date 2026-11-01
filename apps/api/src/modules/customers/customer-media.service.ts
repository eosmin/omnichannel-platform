import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'
import { mediaGalleryWhere, type Viewer } from '@platform/core/messaging'
import { galleryTypeOf } from '@platform/core/storage'

import { countsOf, type GalleryPage } from './customer-media.views'
import type { ListMediaQuery } from './customers.schemas'
import { encodeCursor } from './list-cursor'

// The files of a customer, from `Media.customerId` (set when a file is attached to a message and
// moved to the survivor by a merge), as far as the viewer may open the conversation of each. Every query is filtered by the store of the request.
@Injectable()
export class CustomerMediaService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    storeId: string,
    customerId: string,
    query: ListMediaQuery,
    viewer: Viewer
  ): Promise<GalleryPage> {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: customerId, storeId, mergedIntoId: null },
      select: { id: true }
    })
    if (customer === null) throw resourceNotFound('customer')

    const { cursor } = query
    const [rows, groups] = await Promise.all([
      this.prisma.client.media.findMany({
        where: {
          AND: [
            mediaGalleryWhere(storeId, customerId, query, viewer),
            cursor === undefined
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                  ]
                }
          ]
        },
        select: {
          id: true,
          filename: true,
          contentType: true,
          fileSize: true,
          createdAt: true,
          message: { select: { conversation: { select: { channelType: true } } } }
        },
        take: query.limit + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      }),
      cursor === undefined
        ? this.prisma.client.media.groupBy({
            by: ['contentType'],
            where: mediaGalleryWhere(storeId, customerId, { q: query.q }, viewer),
            _count: { _all: true }
          })
        : Promise.resolve(null)
    ])

    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => ({
        id: row.id,
        type: galleryTypeOf(row.contentType),
        filename: row.filename,
        contentType: row.contentType,
        fileSizeBytes: row.fileSize,
        createdAt: row.createdAt.toISOString(),
        channelType: row.message?.conversation.channelType ?? null
      })),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore,
      counts: groups === null ? null : countsOf(groups)
    }
  }
}
