import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { type Queue, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import sharp from 'sharp'

import { PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { JobNames, type ProcessImageJob, QueueNames } from '@platform/core/queues'
import {
  AllowedContentTypes,
  ImageVariants,
  type ImageVariant,
  ImageVariantSpecs,
  MAX_IMAGE_PIXELS,
  StorageKeys,
  UploadLimits,
  VARIANT_CONTENT_TYPE
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { ClamavClient } from './clamav.client'

const isImage = (contentType: string): boolean =>
  (AllowedContentTypes.IMAGE as readonly string[]).includes(contentType)

// A file is `pending` until it is scanned and is never served before it is `clean` (TDD_07 §6.5).
// Both steps are safe to run twice: a job that finds the media already past its state does nothing.
@Injectable()
export class MediaPipeline {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly clamav: ClamavClient,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ProcessImageJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MediaPipeline.name)
  }

  async scan(mediaId: string): Promise<void> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } })
    if (media === null) return
    // Scanned by an earlier attempt that may have died before queueing the variants: queue them again
    // (same job id, so never twice)
    if (media.status === String(MediaStatus.CLEAN)) {
      if (isImage(media.contentType) && media.processedAt === null)
        await this.queueVariants(media.id)
      return
    }
    if (media.status !== String(MediaStatus.PENDING)) return

    const body = await this.storage.stream(media.key)
    if (body === null) throw new Error('the file to scan is not in the bucket')
    // No verdict (the daemon is down or timed out) throws: the file stays pending and the queue retries
    const verdict = await this.clamav.scan(body)

    if (verdict.infected) {
      // The row is the gate for serving, so it is written first: a failure in between leaves an
      // infected row with its file still in the bucket (never served; the cleanup of PR B2 removes
      // it), and not a pending row whose file is gone and whose scan can never finish.
      const marked = await this.prisma.client.media.updateMany({
        where: { id: media.id, status: MediaStatus.PENDING },
        data: {
          status: MediaStatus.INFECTED,
          scanResult: { viruses: verdict.viruses },
          scannedAt: new Date()
        }
      })
      // Another attempt moved the row first: its verdict stands, and this one deletes nothing
      if (marked.count === 0) return
      this.logger.warn(
        { mediaId: media.id, storeId: media.storeId },
        'an uploaded file is infected'
      )
      await this.storage.delete(media.key)
      return
    }

    const marked = await this.prisma.client.media.updateMany({
      where: { id: media.id, status: MediaStatus.PENDING },
      data: { status: MediaStatus.CLEAN, scannedAt: new Date() }
    })
    if (marked.count === 0) return
    if (isImage(media.contentType)) await this.queueVariants(media.id)
  }

  private async queueVariants(mediaId: string): Promise<void> {
    await this.heavyQueue.add(
      JobNames.PROCESS_IMAGE,
      { mediaId },
      { jobId: `${JobNames.PROCESS_IMAGE}-${mediaId}` }
    )
  }

  async processImage(mediaId: string): Promise<void> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } })
    if (media === null || media.storeId === null) return
    if (media.status !== String(MediaStatus.CLEAN) || media.processedAt !== null) return

    const original = await this.storage.read(media.key, UploadLimits.MAX_FILE_SIZE_BYTES)
    if (original === null) throw new Error('the image to process is not in the bucket')

    const storeId = media.storeId
    const variantKeys = {} as Record<ImageVariant, string>
    for (const variant of Object.values(ImageVariants)) {
      const spec = ImageVariantSpecs[variant]
      let encoded: Buffer
      try {
        // rotate() applies the EXIF orientation; the metadata itself (location, camera) is not kept,
        // because the encoder drops it unless asked to keep it
        encoded = await sharp(original, { limitInputPixels: MAX_IMAGE_PIXELS })
          .rotate()
          .resize(spec.width, spec.height, {
            fit: spec.fit,
            withoutEnlargement: variant !== ImageVariants.THUMB
          })
          .webp({ quality: spec.quality })
          .toBuffer()
      } catch (error) {
        // An image the decoder refuses (corrupt, or too many pixels) is refused again on every
        // attempt. The original stays and is served as a download, without variants.
        throw new UnrecoverableError(
          `the image could not be processed: ${error instanceof Error ? error.message : 'unknown'}`
        )
      }
      // A failure of the bucket is not the image's: it propagates and the queue retries
      const key = StorageKeys.messageVariant(storeId, media.id, variant)
      await this.storage.put(key, encoded, VARIANT_CONTENT_TYPE)
      variantKeys[variant] = key
    }

    await this.prisma.client.media.update({
      where: { id: media.id },
      data: { variants: variantKeys, processedAt: new Date() }
    })
  }
}
