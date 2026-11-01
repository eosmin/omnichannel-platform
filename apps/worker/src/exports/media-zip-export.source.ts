import type { PrismaService } from '@platform/core/database'
import { ExportLimits } from '@platform/core/exports'
import { mediaGalleryWhere, type MediaZipFilters, viewerOf } from '@platform/core/messaging'
import { GalleryLimits } from '@platform/core/storage'

// A file of the ZIP: where it is in the bucket and what it is called inside
export interface ZipEntry {
  key: string
  filename: string
  contentType: string
  modifiedAt: Date
}

export interface ZipSource {
  entries: () => AsyncGenerator<ZipEntry>
}

// The files are more than a ZIP may hold. The request refuses this at the door, but the files can
// grow between the request and the ZIP, so the worker holds the same ceilings.
export class ZipTooLargeError extends Error {
  constructor() {
    super('the files are too many or too large for one ZIP')
    this.name = ZipTooLargeError.name
  }
}

// There is nothing to put in the ZIP: the files were purged between the request and the job
export class ZipEmptyError extends Error {
  constructor() {
    super('there are no files for the ZIP')
    this.name = ZipEmptyError.name
  }
}

// The gallery of the customer as it is now, under the tab and the search the member had: the same
// `mediaGalleryWhere` as the gallery, so the ZIP holds what the member saw (and the files that came
// since). Read in pages by id, so the list of a big customer is never held whole.
export function mediaZipSource(
  prisma: PrismaService,
  storeId: string,
  filters: MediaZipFilters
): ZipSource {
  const viewer = viewerOf(filters.viewer.userId, filters.viewer.held)
  return {
    entries: async function* () {
      // Before a byte is read from the bucket: a selection over the ceiling fails in one query
      const total = await prisma.client.media.aggregate({
        where: mediaGalleryWhere(storeId, filters.customerId, filters, viewer),
        _count: { _all: true },
        _sum: { fileSize: true }
      })
      if (total._count._all === 0) throw new ZipEmptyError()
      if (
        total._count._all > GalleryLimits.ZIP_MAX_FILES ||
        (total._sum.fileSize ?? 0) > GalleryLimits.ZIP_MAX_BYTES
      ) {
        throw new ZipTooLargeError()
      }
      let after: string | undefined
      let files = 0
      let bytes = 0
      for (;;) {
        const page = await prisma.client.media.findMany({
          where: {
            ...mediaGalleryWhere(storeId, filters.customerId, filters, viewer),
            ...(after === undefined ? {} : { id: { gt: after } })
          },
          orderBy: { id: 'asc' },
          take: ExportLimits.ROW_PAGE_SIZE,
          select: {
            id: true,
            key: true,
            filename: true,
            contentType: true,
            fileSize: true,
            createdAt: true
          }
        })
        for (const media of page) {
          files += 1
          bytes += media.fileSize
          if (files > GalleryLimits.ZIP_MAX_FILES || bytes > GalleryLimits.ZIP_MAX_BYTES) {
            throw new ZipTooLargeError()
          }
          yield {
            key: media.key,
            filename: media.filename,
            contentType: media.contentType,
            modifiedAt: media.createdAt
          }
        }
        const last = page.at(-1)
        if (page.length < ExportLimits.ROW_PAGE_SIZE || last === undefined) return
        after = last.id
      }
    }
  }
}
