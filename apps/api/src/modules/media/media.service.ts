import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  type ClientUploadPurpose,
  type ConfirmUploadBody,
  ImageVariants,
  type MediaPurposeType,
  type MediaUrls,
  mediaVariantsSchema,
  type RequestUploadUrlBody,
  MediaPurpose,
  sanitizeFilename,
  StorageKeys,
  type UploadUrlResult,
  QUOTA_WINDOW_MS,
  UploadLimits,
  VARIANT_CONTENT_TYPE
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { countWithinQuota, refuseTypeOrSize, uploadVerificationFailed } from './upload-checks'

export interface MediaView {
  id: string
  purpose: MediaPurposeType
  filename: string
  contentType: string
  fileSize: number
  status: MediaStatus
  createdAt: Date
}

const MEDIA_SELECT = {
  id: true,
  purpose: true,
  filename: true,
  contentType: true,
  fileSize: true,
  status: true,
  createdAt: true,
  key: true,
  variants: true,
  uploadedBy: true
} as const

type MediaRow = Omit<MediaView, 'purpose' | 'status'> & {
  purpose: string
  status: string
  key: string
  variants: unknown
  uploadedBy: string | null
}

interface UploadKeys {
  // Where the client PUTs
  upload: string
  // Where the confirmation copies the file to: the one that is scanned and served
  final: string
}

// A record over every purpose a client may upload for: adding one to ClientUploadPurposes does not
// compile until it has its keys (and its checks) here.
const KEYS_OF_PURPOSE: Record<
  ClientUploadPurpose,
  (storeId: string, mediaId: string, filename: string) => UploadKeys
> = {
  [MediaPurpose.MESSAGE]: (storeId, mediaId, filename) => ({
    upload: StorageKeys.messageUpload(storeId, mediaId, filename),
    final: StorageKeys.message(storeId, mediaId, filename)
  })
}

const keysFor = (
  purpose: ClientUploadPurpose,
  storeId: string,
  mediaId: string,
  filename: string
): UploadKeys => KEYS_OF_PURPOSE[purpose](storeId, mediaId, filename)

// Media is uploaded BEFORE the message that carries it exists (TDD_07 §6.1): the client asks for a
// signed URL, PUTs the file straight to the bucket (the api never sees the bytes) and confirms.
// Everything here is scoped to the store of the request, which comes from TenantGuard.
//
// The signed URL outlives the confirmation (it lasts its TTL), so a client could overwrite the file
// after it was checked. The confirmation therefore copies it to a key the client has no URL for and
// deletes the one it uploaded to: what is scanned and served is never writable by the uploader.
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>
  ) {}

  async requestUploadUrl(
    storeId: string,
    userId: string,
    body: RequestUploadUrlBody
  ): Promise<UploadUrlResult> {
    refuseTypeOrSize(body.contentType, body.fileSizeBytes)
    await this.takeQuota(storeId, userId)

    // Chosen by the server: it becomes Media.id on confirmation and is part of the key, so a client
    // cannot confirm a key it was not given
    const mediaId = crypto.randomUUID()
    const key = keysFor(body.purpose, storeId, mediaId, sanitizeFilename(body.filename)).upload
    const uploadUrl = await this.storage.uploadUrl({
      key,
      contentType: body.contentType,
      contentLength: body.fileSizeBytes
    })
    // Who asked: only that user may confirm it (the ids travel through the browser)
    await this.redis.set(
      CacheKeys.upload.requester(storeId, mediaId),
      userId,
      'EX',
      UploadLimits.PENDING_UPLOAD_TTL_SECONDS
    )
    return { uploadUrl, key, mediaId }
  }

  // A signed url writes nothing until it is used, so what is counted is the asking, by the hour. The
  // member's counter is taken first and the store's only for a request the member's let through: a
  // member who keeps asking after the refusal cannot use up the quota of the whole store. Each counter
  // is one script (count and expiry together), so a crash cannot leave one that never expires.
  private async takeQuota(storeId: string, userId: string): Promise<void> {
    const bucket = Math.floor(Date.now() / QUOTA_WINDOW_MS)
    const counters = [
      {
        key: CacheKeys.upload.userQuota(storeId, userId, bucket),
        limit: UploadLimits.SIGNED_URLS_PER_USER_PER_HOUR
      },
      {
        key: CacheKeys.upload.storeQuota(storeId, bucket),
        limit: UploadLimits.SIGNED_URLS_PER_STORE_PER_HOUR
      }
    ]
    for (const counter of counters) {
      await countWithinQuota(this.redis, counter.key, counter.limit)
    }
  }

  async confirmUpload(
    storeId: string,
    userId: string,
    body: ConfirmUploadBody
  ): Promise<MediaView> {
    // A key of another store is a cross-tenant attempt, whatever else is wrong with the request
    if (!body.key.startsWith(StorageKeys.storePrefix(storeId))) {
      throw new PlatformException(
        ErrorCodes.FILE_KEY_OUT_OF_SCOPE,
        'Key outside store scope',
        HttpStatusCodes.FORBIDDEN
      )
    }
    const filename = sanitizeFilename(body.filename)
    const keys = keysFor(body.purpose, storeId, body.mediaId, filename)
    // Not any object of the store: the one signed for this media id and name. Without this a member
    // could attach an export or another message's file as their own upload.
    if (body.key !== keys.upload) throw uploadVerificationFailed()
    refuseTypeOrSize(body.contentType, body.fileSizeBytes)

    // A retry of a confirmation that already went through answers with the same media. The scan is
    // queued again (under the same job id, so never twice): the first attempt may have died between
    // writing the row and queueing it.
    const existing = await this.find(storeId, body.mediaId)
    if (existing !== null) return this.again(existing, keys, userId)

    // Only who asked for the signed url confirms it. Same answer as any other bad upload.
    const requester = await this.redis.get(CacheKeys.upload.requester(storeId, body.mediaId))
    if (requester !== userId) throw uploadVerificationFailed()

    const stored = await this.storage.head(keys.upload)
    if (
      stored === null ||
      stored.contentLength !== body.fileSizeBytes ||
      stored.contentType !== body.contentType
    ) {
      throw uploadVerificationFailed()
    }
    // Pinned to the bytes just checked: the signed URL is still valid, and a file put there since
    // is refused instead of promoted
    if (!(await this.storage.copy(keys.upload, keys.final, stored.etag))) {
      throw uploadVerificationFailed()
    }

    let media: MediaRow
    try {
      media = await this.prisma.client.media.create({
        data: {
          id: body.mediaId,
          storeId,
          purpose: body.purpose,
          uploadedBy: userId,
          key: keys.final,
          filename,
          contentType: body.contentType,
          fileSize: body.fileSizeBytes,
          status: MediaStatus.PENDING
        },
        select: MEDIA_SELECT
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // Two confirmations at once: the other one won
      const winner = await this.find(storeId, body.mediaId)
      if (winner === null) throw uploadVerificationFailed()
      return this.again(winner, keys, userId)
    }

    await this.queueScan(media.id)
    await this.dropStaging(keys.upload)
    await this.redis.del(CacheKeys.upload.requester(storeId, body.mediaId))
    return view(media)
  }

  // Short-lived signed URLs on the bucket host (TDD_07 §6.6). Only a clean file is served; the original
  // is always a download, and only the WebP variants the worker made are shown inline.
  async urlsFor(storeId: string, mediaId: string): Promise<MediaUrls> {
    const media = await this.find(storeId, mediaId)
    if (media === null) throw resourceNotFound('Media not found')
    if (media.status === String(MediaStatus.INFECTED)) {
      throw new PlatformException(
        ErrorCodes.FILE_INFECTED,
        'File unavailable',
        HttpStatusCodes.FORBIDDEN
      )
    }
    if (media.status !== String(MediaStatus.CLEAN)) {
      throw new PlatformException(
        ErrorCodes.FILE_NOT_READY,
        'File is being scanned',
        HttpStatusCodes.CONFLICT
      )
    }

    // A JSON column: parsed at the boundary. A value that does not fit is no variant, not an error.
    const parsed = mediaVariantsSchema.safeParse(media.variants ?? {})
    const variants = parsed.success ? parsed.data : {}
    // Keys the worker wrote for this media; one outside the store is never signed
    const sign = (variant: (typeof ImageVariants)[keyof typeof ImageVariants]) => {
      const key = variants[variant]
      return key === undefined || !key.startsWith(StorageKeys.storePrefix(storeId))
        ? Promise.resolve(null)
        : this.storage.downloadUrl({
            key,
            contentType: VARIANT_CONTENT_TYPE,
            filename: media.filename,
            inline: true
          })
    }
    const [url, full, medium, thumb] = await Promise.all([
      this.storage.downloadUrl({
        key: media.key,
        contentType: media.contentType,
        filename: media.filename
      }),
      sign(ImageVariants.FULL),
      sign(ImageVariants.MEDIUM),
      sign(ImageVariants.THUMB)
    ])
    return {
      url,
      filename: media.filename,
      contentType: media.contentType,
      variants: {
        [ImageVariants.FULL]: full,
        [ImageVariants.MEDIUM]: medium,
        [ImageVariants.THUMB]: thumb
      }
    }
  }

  private async again(media: MediaRow, keys: UploadKeys, userId: string): Promise<MediaView> {
    if (media.key !== keys.final || media.uploadedBy !== userId) throw uploadVerificationFailed()
    if (media.status === String(MediaStatus.PENDING)) {
      await this.queueScan(media.id)
      await this.dropStaging(keys.upload)
    }
    return view(media)
  }

  // The uploader's copy is of no use once the file is at its final key, and its signed URL is still
  // writable until it expires. A failure here leaves a stray object, not a wrong media: it is logged,
  // and the orphan cleanup of the worker removes it.
  private async dropStaging(key: string): Promise<void> {
    try {
      await this.storage.delete(key)
    } catch (error) {
      this.logger.warn({ key, err: error }, 'could not delete the staging object of an upload')
    }
  }

  // Scan first; PROCESS_IMAGE is queued by the scan job only after a clean result
  private async queueScan(mediaId: string): Promise<void> {
    await this.heavyQueue.add(
      JobNames.SCAN_FILE,
      { mediaId },
      { jobId: `${JobNames.SCAN_FILE}-${mediaId}` }
    )
  }

  private find(storeId: string, mediaId: string): Promise<MediaRow | null> {
    return this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId },
      select: MEDIA_SELECT
    })
  }
}

function view(row: MediaRow): MediaView {
  return {
    id: row.id,
    purpose: row.purpose as MediaPurposeType,
    filename: row.filename,
    contentType: row.contentType,
    fileSize: row.fileSize,
    status: row.status as MediaStatus,
    createdAt: row.createdAt
  }
}
