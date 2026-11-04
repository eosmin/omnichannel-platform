import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'

import { CacheKeys } from '@platform/core/cache'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  AvatarProcessing,
  MediaPurpose,
  QUOTA_WINDOW_MS,
  sanitizeFilename,
  StorageKeys,
  type UploadUrlResult
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import type { ConfirmAvatarUploadBody, RequestAvatarUploadBody } from './avatar.schemas'
import {
  countWithinQuota,
  refuseSignatureMismatch,
  refuseTypeOrSize,
  uploadVerificationFailed
} from './upload-checks'

export interface AvatarUploadView {
  mediaId: string
  status: MediaStatus
}

const ROW_SELECT = { id: true, key: true, status: true } as const

// The picture of a person, uploaded the way a message file is (a signed url, a PUT straight to the
// bucket, a confirmation) but on routes of the account: the picture belongs to the person and to no
// store, so nothing here takes a store or a permission, and the quota is the person's own. The id is
// always the access token's.
//
// What the person uploaded is never served. The worker scans it and then re-encodes it to a small WebP,
// which drops the metadata (location, camera); only that file gets a link (AccountSettingsService).
@Injectable()
export class AvatarUploadsService {
  private readonly logger = new Logger(AvatarUploadsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>
  ) {}

  async requestUploadUrl(userId: string, body: RequestAvatarUploadBody): Promise<UploadUrlResult> {
    refuseTypeOrSize(body.contentType, body.fileSizeBytes, MediaPurpose.AVATAR)
    // A signed url writes nothing until it is used, so what is counted is the asking, by the hour
    await countWithinQuota(
      this.redis,
      CacheKeys.upload.avatarQuota(userId, Math.floor(Date.now() / QUOTA_WINDOW_MS)),
      AvatarProcessing.SIGNED_URLS_PER_USER_PER_HOUR
    )
    // Chosen by the server: it becomes Media.id on confirmation and is part of the key
    const mediaId = crypto.randomUUID()
    const key = StorageKeys.avatarUpload(userId, mediaId, sanitizeFilename(body.filename))
    const uploadUrl = await this.storage.uploadUrl({
      key,
      contentType: body.contentType,
      contentLength: body.fileSizeBytes
    })
    return { uploadUrl, key, mediaId }
  }

  // No record of who asked is kept (the upload of a store keeps one because its ids travel through
  // the browser of any member): the key holds the user's id, so the object this finds is one that a
  // url signed for this very user wrote.
  async confirmUpload(userId: string, body: ConfirmAvatarUploadBody): Promise<AvatarUploadView> {
    // A key of another user is an attempt on someone's files, whatever else is wrong with the request
    if (!body.key.startsWith(StorageKeys.userPrefix(userId))) {
      throw new PlatformException(
        ErrorCodes.FILE_KEY_OUT_OF_SCOPE,
        'Key outside user scope',
        HttpStatusCodes.FORBIDDEN
      )
    }
    const filename = sanitizeFilename(body.filename)
    const upload = StorageKeys.avatarUpload(userId, body.mediaId, filename)
    const final = StorageKeys.avatar(userId, body.mediaId, filename)
    // Not any object of the user: the one signed for this media id and name
    if (body.key !== upload) throw uploadVerificationFailed()
    refuseTypeOrSize(body.contentType, body.fileSizeBytes, MediaPurpose.AVATAR)

    // A retry of a confirmation that went through answers with the same media; the scan is queued again
    // (same job id, so never twice): the first attempt may have died between the row and the queue
    const existing = await this.findOwn(userId, body.mediaId)
    if (existing !== null) return this.again(existing, final, upload)

    // Rows the person holds: a bound on what one account makes the scan and the worker do while
    // nothing is attached (the cleanup frees the unattached ones after a day)
    const held = await this.prisma.client.media.count({
      where: { storeId: null, purpose: MediaPurpose.AVATAR, uploadedBy: userId }
    })
    if (held >= AvatarProcessing.MAX_ROWS_PER_USER) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'Too many pending avatars',
        HttpStatusCodes.TOO_MANY_REQUESTS
      )
    }

    const stored = await this.storage.head(upload)
    if (
      stored === null ||
      stored.contentLength !== body.fileSizeBytes ||
      stored.contentType !== body.contentType
    ) {
      throw uploadVerificationFailed()
    }
    // What the bytes are, not what the client says they are
    try {
      await refuseSignatureMismatch(this.storage, upload, body.contentType, stored.etag)
    } catch (error) {
      // A refused file is not kept for another try: its signed url is still writable
      await this.dropStaging(upload)
      throw error
    }
    // Pinned to the bytes just checked: the signed url is still valid until it expires, and a file put
    // there since is refused instead of promoted
    if (!(await this.storage.copy(upload, final, stored.etag))) throw uploadVerificationFailed()

    try {
      await this.prisma.client.media.create({
        data: {
          id: body.mediaId,
          // The picture is the person's: no store, so deleting a store never takes it
          storeId: null,
          purpose: MediaPurpose.AVATAR,
          uploadedBy: userId,
          key: final,
          filename,
          contentType: body.contentType,
          fileSize: body.fileSizeBytes,
          status: MediaStatus.PENDING
        },
        select: ROW_SELECT
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // Two confirmations at once: the other one won
      const winner = await this.findOwn(userId, body.mediaId)
      if (winner === null) throw uploadVerificationFailed()
      return this.again(winner, final, upload)
    }

    await this.queueScan(body.mediaId)
    await this.dropStaging(upload)
    return { mediaId: body.mediaId, status: MediaStatus.PENDING }
  }

  private async again(
    media: { id: string; key: string; status: string },
    final: string,
    upload: string
  ): Promise<AvatarUploadView> {
    // The worker moves the key of a picture it has re-encoded: a row past that point is the same upload
    if (media.status === String(MediaStatus.PENDING)) {
      if (media.key !== final) throw uploadVerificationFailed()
      await this.queueScan(media.id)
      await this.dropStaging(upload)
    }
    return { mediaId: media.id, status: media.status as MediaStatus }
  }

  // A failure leaves a stray object, not a wrong media: it is logged and the orphan cleanup of the
  // worker removes it
  private async dropStaging(key: string): Promise<void> {
    try {
      await this.storage.delete(key)
    } catch (error) {
      this.logger.warn({ key, err: error }, 'could not delete the staging object of an avatar')
    }
  }

  private async queueScan(mediaId: string): Promise<void> {
    await this.heavyQueue.add(
      JobNames.SCAN_FILE,
      { mediaId },
      { jobId: `${JobNames.SCAN_FILE}-${mediaId}` }
    )
  }

  private findOwn(userId: string, mediaId: string) {
    return this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId: null, purpose: MediaPurpose.AVATAR, uploadedBy: userId },
      select: ROW_SELECT
    })
  }
}
