import { InjectQueue } from '@nestjs/bullmq'
import { Injectable, Logger } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import {
  type ClientUploadPurpose,
  type ConfirmUploadBody,
  type MediaPurposeType,
  maxBytesFor,
  refuseUpload,
  type RequestUploadUrlBody,
  MediaPurpose,
  sanitizeFilename,
  StorageKeys,
  type UploadUrlResult,
  UploadRefusals
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

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
  key: true
} as const

type MediaRow = Omit<MediaView, 'purpose' | 'status'> & {
  purpose: string
  status: string
  key: string
}

// The one answer for an upload that cannot be trusted: the object is missing, is not what was
// declared, or is not the one signed for this media. It says nothing about which of those.
function uploadVerificationFailed(): PlatformException {
  return new PlatformException(
    ErrorCodes.FILE_UPLOAD_FAILED,
    'Upload verification failed',
    HttpStatusCodes.BAD_REQUEST
  )
}

function refuseTypeOrSize(contentType: string, fileSizeBytes: number): void {
  const refused = refuseUpload(contentType, fileSizeBytes)
  if (refused === UploadRefusals.TYPE_NOT_ALLOWED) {
    throw new PlatformException(
      ErrorCodes.FILE_TYPE_NOT_ALLOWED,
      'File type not allowed',
      HttpStatusCodes.BAD_REQUEST,
      { contentType }
    )
  }
  if (refused === UploadRefusals.TOO_LARGE) {
    throw new PlatformException(
      ErrorCodes.FILE_TOO_LARGE,
      'File too large',
      HttpStatusCodes.BAD_REQUEST,
      { maxSizeBytes: maxBytesFor(contentType) }
    )
  }
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
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>
  ) {}

  async requestUploadUrl(storeId: string, body: RequestUploadUrlBody): Promise<UploadUrlResult> {
    refuseTypeOrSize(body.contentType, body.fileSizeBytes)

    // Chosen by the server: it becomes Media.id on confirmation and is part of the key, so a client
    // cannot confirm a key it was not given
    const mediaId = crypto.randomUUID()
    const key = keysFor(body.purpose, storeId, mediaId, sanitizeFilename(body.filename)).upload
    const uploadUrl = await this.storage.uploadUrl({
      key,
      contentType: body.contentType,
      contentLength: body.fileSizeBytes
    })
    return { uploadUrl, key, mediaId }
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
    if (existing !== null) return this.again(existing, keys)

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
      return this.again(winner, keys)
    }

    await this.queueScan(media.id)
    await this.dropStaging(keys.upload)
    return view(media)
  }

  private async again(media: MediaRow, keys: UploadKeys): Promise<MediaView> {
    if (media.key !== keys.final) throw uploadVerificationFailed()
    if (media.status === String(MediaStatus.PENDING)) {
      await this.queueScan(media.id)
      await this.dropStaging(keys.upload)
    }
    return view(media)
  }

  // The uploader's copy is of no use once the file is at its final key, and its signed URL is still
  // writable until it expires. A failure here leaves a stray object, not a wrong media: it is logged,
  // and the cleanup of staging objects (Step 3.4, PR B) removes it.
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
