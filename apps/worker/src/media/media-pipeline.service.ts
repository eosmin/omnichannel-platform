import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { type Queue, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import sharp from 'sharp'

import { PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { publishMessageChanged } from '@platform/core/messaging'
import { JobNames, type ProcessImageJob, QueueNames } from '@platform/core/queues'
import {
  AllowedContentTypes,
  ImageVariants,
  type ImageVariant,
  ImageVariantSpecs,
  AvatarProcessing,
  AvatarUpload,
  keepsAnimation,
  MAX_IMAGE_PIXELS,
  MediaPurpose,
  parseAvatarKey,
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
    private readonly events: DomainEvents,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ProcessImageJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(MediaPipeline.name)
  }

  // `lastAttempt` is true on the last try the job has: a scan that still has no verdict then is given
  // up for good (see `giveUp`), instead of being queued again by the hourly cleanup for ever.
  async scan(mediaId: string, lastAttempt = false): Promise<void> {
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
    if (body === null) {
      // A picture replaced or removed while its job waited: the row and file went together
      if (await this.isGone(media.id)) return
      throw new Error('the file to scan is not in the bucket')
    }
    // No verdict (the daemon is down or timed out) throws: the file stays pending and the queue retries
    let verdict
    try {
      verdict = await this.clamav.scan(body)
    } catch (error) {
      if (lastAttempt) await this.giveUp(media)
      throw error
    }

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
      // Never throws, so the delete below always runs
      await this.announce(media, Events.MEDIA_INFECTED)
      await this.storage.delete(media.key)
      return
    }

    const marked = await this.prisma.client.media.updateMany({
      where: { id: media.id, status: MediaStatus.PENDING },
      data: { status: MediaStatus.CLEAN, scannedAt: new Date() }
    })
    if (marked.count === 0) return
    await this.announce(media, Events.MEDIA_PROCESSED)
    if (isImage(media.contentType)) await this.queueVariants(media.id)
  }

  // The daemon gave no verdict on any try. The row goes to a terminal state the cleanup does not look
  // at, so it is never queued again, and the file leaves the bucket: it was never scanned, so it is
  // never served. The row is written first (the gate), as for an infected file. The error of the scan
  // still propagates, so the job ends as failed and goes to the dead-letter queue.
  private async giveUp(media: { id: string; key: string; storeId: string | null }): Promise<void> {
    try {
      const marked = await this.prisma.client.media.updateMany({
        where: { id: media.id, status: MediaStatus.PENDING },
        data: { status: MediaStatus.UNSCANNABLE, scannedAt: new Date() }
      })
      if (marked.count === 0) return
      this.logger.error(
        { mediaId: media.id, storeId: media.storeId },
        'an uploaded file could not be scanned and was given up'
      )
      // The file first: announce never throws, but the delete is what must not be skipped
      await this.storage.delete(media.key)
      await this.announce(media, Events.MEDIA_UNSCANNABLE)
    } catch (error) {
      // The next hourly pass of the cleanup deletes the file of an unscannable row
      this.logger.warn(
        { mediaId: media.id, errorName: errorName(error) },
        'an unscannable file was not settled'
      )
    }
  }

  // Tells the team that a file of a message has a verdict, so the thread stops showing its placeholder.
  // The picture of an ad hangs from its origin, not from a message: it is announced as the message that
  // carried the ad, whose thread scope also holds the origins of the conversation. A file that belongs
  // to neither yet has no thread to refresh: the composer asks for it itself.
  private async announce(
    media: { id: string; storeId: string | null },
    event:
      typeof Events.MEDIA_PROCESSED | typeof Events.MEDIA_INFECTED | typeof Events.MEDIA_UNSCANNABLE
  ): Promise<void> {
    if (media.storeId === null) return
    const { storeId } = media
    // The verdict is already written and a retry would not announce it again (the row is past its
    // state), so a failure here is logged and must not fail the job; the next fetch of the thread
    // shows the state anyway
    try {
      // Read now, not at the start of the job: a send may have linked the file while it was processed
      const current = await this.prisma.client.media.findUnique({
        where: { id: media.id },
        select: { messageId: true, origin: { select: { messageId: true } } }
      })
      const messageId = current?.messageId ?? current?.origin?.messageId ?? null
      if (messageId === null) return
      await this.prisma.transaction(tx =>
        publishMessageChanged(this.events, tx, event, storeId, messageId)
      )
    } catch (error) {
      this.logger.warn(
        { mediaId: media.id, errorName: errorName(error) },
        'a file verdict was not announced'
      )
    }
  }

  private async queueVariants(mediaId: string): Promise<void> {
    await this.heavyQueue.add(
      JobNames.PROCESS_IMAGE,
      { mediaId },
      { jobId: `${JobNames.PROCESS_IMAGE}-${mediaId}` }
    )
  }

  // The picture of a person, scanned clean: re-encoded to one small square WebP, which is the only file
  // of it that is ever served. The encoder drops the metadata of the upload (location, camera) unless
  // asked to keep it. The row is pointed at the new file (the gate for serving: AccountSettingsService
  // gives a link only once `processedAt` is set) and the uploaded file is deleted. Safe to run twice: a
  // retry writes the same key again.
  private async processAvatar(media: {
    id: string
    key: string
    uploadedBy: string | null
  }): Promise<void> {
    const owner = parseAvatarKey(media.key)?.userId
    // A row that does not sit under its own user's files is not served
    if (owner === undefined || owner !== media.uploadedBy) {
      this.logger.error(
        { mediaId: media.id },
        'an avatar is not under its own user and was refused'
      )
      await this.prisma.client.media.updateMany({
        where: { id: media.id, status: MediaStatus.CLEAN, processedAt: null },
        data: { status: MediaStatus.UNSCANNABLE, scannedAt: new Date() }
      })
      return
    }
    const original = await this.storage.read(media.key, AvatarUpload.MAX_SIZE_BYTES)
    if (original === null) {
      // Replaced or removed while the job waited: the row and file went together
      if (await this.isGone(media.id)) return
      throw new Error('the avatar to process is not in the bucket')
    }

    let encoded: Buffer
    try {
      encoded = await sharp(original, {
        limitInputPixels: AvatarProcessing.MAX_INPUT_PIXELS,
        // A photo with a small flaw in its tail is still a photo; only a file that cannot be decoded fails
        failOn: 'error'
      })
        .rotate()
        .resize(AvatarProcessing.IMAGE_PIXELS, AvatarProcessing.IMAGE_PIXELS, { fit: 'cover' })
        .webp({ quality: AvatarProcessing.IMAGE_QUALITY })
        .toBuffer()
    } catch (error) {
      // A file the decoder refuses is refused on every attempt, and a picture that cannot be re-encoded
      // cannot have its metadata removed: it is never served. Terminal, like a file nobody could scan.
      this.logger.warn(
        { mediaId: media.id, errorName: errorName(error) },
        'an avatar could not be re-encoded and was refused'
      )
      const marked = await this.prisma.client.media.updateMany({
        where: { id: media.id, status: MediaStatus.CLEAN, processedAt: null },
        data: { status: MediaStatus.UNSCANNABLE, scannedAt: new Date() }
      })
      if (marked.count > 0) await this.storage.delete(media.key)
      return
    }

    const key = StorageKeys.avatarImage(owner, media.id)
    // A failure of the bucket is not the image's: it propagates and the queue retries
    await this.storage.put(key, encoded, VARIANT_CONTENT_TYPE)
    const done = await this.prisma.client.media.updateMany({
      where: { id: media.id, status: MediaStatus.CLEAN, processedAt: null },
      data: {
        key,
        filename: AvatarProcessing.IMAGE_FILENAME,
        contentType: VARIANT_CONTENT_TYPE,
        fileSize: encoded.length,
        processedAt: new Date()
      }
    })
    if (done.count === 0) {
      // The person replaced or removed the picture while it was processed: the row is gone
      await this.storage.delete(key)
      return
    }
    // The uploaded file is of no use now. A failure leaves a stray object that is never served and that
    // the orphan cleanup removes (it is not the file of its row).
    if (media.key !== key) {
      try {
        await this.storage.delete(media.key)
      } catch (error) {
        this.logger.warn(
          { mediaId: media.id, errorName: errorName(error) },
          'the uploaded file of an avatar was not deleted'
        )
      }
    }
  }

  private async isGone(mediaId: string): Promise<boolean> {
    const row = await this.prisma.client.media.findUnique({
      where: { id: mediaId },
      select: { id: true }
    })
    return row === null
  }

  async processImage(mediaId: string): Promise<void> {
    const media = await this.prisma.client.media.findUnique({ where: { id: mediaId } })
    if (media === null) return
    if (media.status !== String(MediaStatus.CLEAN) || media.processedAt !== null) return
    // A picture of a person has no store and its own, smaller processing
    if (media.storeId === null) {
      if (media.purpose === String(MediaPurpose.AVATAR)) await this.processAvatar(media)
      return
    }

    const original = await this.storage.read(media.key, UploadLimits.MAX_FILE_SIZE_BYTES)
    if (original === null) throw new Error('the image to process is not in the bucket')

    const storeId = media.storeId
    // The keys put in the bucket so far: a refusal or a deleted row takes them out again
    const written: string[] = []
    // Whether the big variants move. The header (format, frame count, size of a frame, orientation) is
    // read first, without decoding a frame, and the caps are checked on it: only an animation inside
    // them is decoded whole.
    let animated: boolean
    try {
      const header = await sharp(original, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
      animated = keepsAnimation(media.contentType, header)
    } catch (error) {
      return this.refuseImage(media, error, written)
    }
    let variantKeys: Record<ImageVariant, string>
    try {
      variantKeys = await this.makeVariants(original, media.id, storeId, animated, written)
    } catch (error) {
      if (!(error instanceof ImageNotEncoded)) throw error
      if (!animated) return this.refuseImage(media, error.reason, written)
      // An animation the encoder would not take whole is drawn from its first frame instead of
      // refused: the same keys are written again, still
      try {
        variantKeys = await this.makeVariants(original, media.id, storeId, false, written)
      } catch (second) {
        if (!(second instanceof ImageNotEncoded)) throw second
        return this.refuseImage(media, second.reason, written)
      }
    }

    // Guarded like the refusal: a second attempt of a stalled job finds the row settled and stops, and
    // the keys are the same ones, so there is nothing to undo
    const settled = await this.prisma.client.media.updateMany({
      where: { id: media.id, status: MediaStatus.CLEAN, processedAt: null },
      data: { variants: variantKeys, processedAt: new Date() }
    })
    if (settled.count === 0) {
      // The file was removed while its variants were made: they belong to nobody
      if (await this.isGone(media.id)) await this.dropVariants(written)
      return
    }
    // The thread draws the variants once they exist
    await this.announce(media, Events.MEDIA_PROCESSED)
  }

  // The three WebP variants, put in the bucket under their own keys. An error of the encoder is the
  // image's (`ImageNotEncoded`); one of the bucket is not, and propagates so that the queue retries.
  private async makeVariants(
    original: Buffer,
    mediaId: string,
    storeId: string,
    animated: boolean,
    written: string[]
  ): Promise<Record<ImageVariant, string>> {
    const variantKeys = {} as Record<ImageVariant, string>
    for (const variant of Object.values(ImageVariants)) {
      const spec = ImageVariantSpecs[variant]
      let encoded: Buffer
      try {
        // rotate() applies the EXIF orientation; the metadata itself (location, camera) is not kept,
        // because the encoder drops it unless asked to keep it. The thumb is always a still: it is a
        // square crop of 160 px that nobody watches move.
        encoded = await sharp(original, {
          limitInputPixels: MAX_IMAGE_PIXELS,
          animated: animated && variant !== ImageVariants.THUMB
        })
          .rotate()
          .resize(spec.width, spec.height, {
            fit: spec.fit,
            withoutEnlargement: variant !== ImageVariants.THUMB
          })
          .webp({ quality: spec.quality })
          .toBuffer()
      } catch (error) {
        throw new ImageNotEncoded(error)
      }
      const key = StorageKeys.messageVariant(storeId, mediaId, variant)
      await this.storage.put(key, encoded, VARIANT_CONTENT_TYPE)
      if (!written.includes(key)) written.push(key)
      variantKeys[variant] = key
    }
    return variantKeys
  }

  // Best effort: an object that stays is one nobody refers to, and the pass of the cleanup that looks
  // for objects with no row finds it
  private async dropVariants(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.storage.delete(key)
      } catch (error) {
        this.logger.warn(
          { errorName: errorName(error) },
          'a variant that nobody refers to was not deleted'
        )
      }
    }
  }

  // An image the decoder refuses (corrupt, or too many pixels) is refused again on every attempt. The
  // original stays and is served as a download, without variants. The row is settled (`processedAt`)
  // and announced, so the thread stops showing its placeholder for variants that will never come and
  // the hourly cleanup does not queue the same file again; the variants already put in the bucket go,
  // because the row will never name them. The error still ends the job as failed.
  private async refuseImage(
    media: { id: string; storeId: string | null },
    error: unknown,
    written: readonly string[]
  ): Promise<never> {
    const marked = await this.prisma.client.media.updateMany({
      where: { id: media.id, status: MediaStatus.CLEAN, processedAt: null },
      data: { processedAt: new Date() }
    })
    if (marked.count > 0) await this.announce(media, Events.MEDIA_PROCESSED)
    await this.dropVariants(written)
    throw new UnrecoverableError(
      `the image could not be processed: ${error instanceof Error ? error.message : 'unknown'}`
    )
  }
}

// The encoder refused the image (not the bucket): carries what it said
class ImageNotEncoded extends Error {
  constructor(readonly reason: unknown) {
    super('the image could not be encoded')
  }
}
