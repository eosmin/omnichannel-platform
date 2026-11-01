import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { withTimeout } from '@platform/channels/connections'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  MediaStatus,
  OriginMediaSlots,
  OriginMediaTypes,
  type OriginMediaSlot
} from '@platform/core/domain'
import {
  type FetchOriginMediaJob,
  JobNames,
  QueueNames,
  type ScanFileJob
} from '@platform/core/queues'
import {
  AllowedContentTypes,
  MediaPurpose,
  sanitizeFilename,
  StorageKeys,
  UploadLimits
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { bareType, FileRefused, GENERIC_TYPES, readLimited, sniffImageType } from './fetch-helpers'
import { originMediaId } from './inbound-media-id'
import { PinnedFetchFailed, pinnedHttpsGet } from './pinned-https-get'
import { UnsafeUrlError } from './public-url'

const IMAGE_TYPES: ReadonlySet<string> = new Set(AllowedContentTypes.IMAGE)

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

// The core, not a plugin, fetches the pictures of an ad: the provider sends links to its CDN. The
// request goes to the public address that was checked and to no other, follows no redirect and takes
// only an image within the size of any image. What is kept is a file of the store, `pending` until
// the scan says otherwise, like any upload. Safe to run twice: one origin and slot, one media.
@Injectable()
export class OriginMediaFetcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OriginMediaFetcher.name)
  }

  // Throws when the attempt should be repeated; returns when the file is stored or will never be
  async fetch(job: FetchOriginMediaJob): Promise<void> {
    const { storeId, originId, slot } = job
    const mediaId = originMediaId(originId, slot)

    // An earlier attempt got this far: only the scan may be missing
    const existing = await this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId },
      select: { status: true }
    })
    if (existing !== null) {
      if (existing.status === String(MediaStatus.PENDING)) await this.queueScan(mediaId)
      return
    }

    const origin = await this.prisma.client.conversationOrigin.findFirst({
      where: { id: originId, storeId },
      select: { mediaType: true, mediaUrl: true, thumbnailUrl: true }
    })
    // Gone since the job was queued
    if (origin === null) return
    const link = this.linkOf(origin, slot)
    if (link === null) return

    let fetched: { body: Buffer; contentType: string }
    try {
      fetched = await this.download(link)
    } catch (error) {
      if (error instanceof FileRefused || error instanceof UnsafeUrlError) {
        // The same answer on every try: the origin keeps no picture
        this.logger.warn(
          { originId, slot, reason: error.message },
          'a picture of an ad was not kept'
        )
        return
      }
      if (error instanceof PinnedFetchFailed && !error.retryable) {
        this.logger.warn({ originId, slot, reason: error.message }, 'a picture of an ad is gone')
        return
      }
      // Also on the last attempt: the job then reaches the dead-letter queue, where it is seen
      throw error
    }

    // The name comes from the link of the ad: cleaned once, for the key and the row
    const filename = sanitizeFilename(this.nameOf(link, slot, fetched.contentType))
    const key = StorageKeys.message(storeId, mediaId, filename)
    await this.storage.put(key, fetched.body, fetched.contentType)
    try {
      await this.prisma.client.media.create({
        data: {
          id: mediaId,
          storeId,
          purpose: MediaPurpose.ORIGIN,
          originId,
          originSlot: slot,
          uploadedBy: null,
          key,
          filename,
          contentType: fetched.contentType,
          fileSize: fetched.body.length,
          status: MediaStatus.PENDING
        }
      })
    } catch (error) {
      // Another attempt wrote the row first; the file it wrote is the same one
      if (!isUniqueViolation(error)) throw error
    }
    await this.queueScan(mediaId)
  }

  // The thumbnail is the picture of the card; the media is kept only when it is an image: a video of an
  // ad is the biggest file that comes in and nothing draws it
  private linkOf(
    origin: { mediaType: string | null; mediaUrl: string | null; thumbnailUrl: string | null },
    slot: OriginMediaSlot
  ): string | null {
    if (slot === OriginMediaSlots.THUMBNAIL) return origin.thumbnailUrl
    // The same link as the thumbnail is one file, which the thumbnail slot keeps
    if (origin.mediaUrl === origin.thumbnailUrl) return null
    return origin.mediaType === OriginMediaTypes.IMAGE ? origin.mediaUrl : null
  }

  // The name of the link without its extension, and the extension of the type that was checked: a link
  // that says .jpg over PNG bytes must not name a file by the wrong one
  private nameOf(link: string, slot: OriginMediaSlot, contentType: string): string {
    let base: string = slot
    try {
      const last = new URL(link).pathname.split('/').filter(Boolean).at(-1)
      if (last !== undefined) base = decodeURIComponent(last).replace(/\.[^.]*$/, '') || slot
    } catch {
      // A link that does not parse was refused before; the slot names the file
    }
    return `${base}${EXTENSIONS[contentType] ?? ''}`
  }

  private async download(link: string): Promise<{ body: Buffer; contentType: string }> {
    let cancelled = false
    let open: { destroy?: () => void } | undefined
    try {
      return await withTimeout(
        (async () => {
          const file = await pinnedHttpsGet(link, {
            accept: [...IMAGE_TYPES].join(', '),
            timeoutMs: UploadLimits.INBOUND_FETCH_TIMEOUT_MS
          })
          open = file.stream
          if (cancelled) {
            open.destroy?.()
            throw new FileRefused('the fetch took too long')
          }
          // A CDN that serves a signed object as a generic download declares no type: the bytes say it
          const declared = bareType(file.contentType)
          if (!IMAGE_TYPES.has(declared) && !GENERIC_TYPES.has(declared)) {
            throw new FileRefused('the file is not an image')
          }
          const limit = UploadLimits.MAX_FILE_SIZE_BYTES
          if (file.contentLength !== null && file.contentLength > limit) {
            throw new FileRefused('the file is bigger than the limit')
          }
          const body = await readLimited(file.stream, limit)
          if (body.length === 0) throw new FileRefused('the file is empty')
          const contentType = IMAGE_TYPES.has(declared) ? declared : sniffImageType(body)
          if (contentType === null) throw new FileRefused('the file is not an image')
          return { body, contentType }
        })(),
        UploadLimits.INBOUND_FETCH_TIMEOUT_MS
      )
    } catch (error) {
      cancelled = true
      open?.destroy?.()
      throw error
    }
  }

  private async queueScan(mediaId: string): Promise<void> {
    await this.heavyQueue.add(
      JobNames.SCAN_FILE,
      { mediaId },
      { jobId: `${JobNames.SCAN_FILE}-${mediaId}` }
    )
  }
}
