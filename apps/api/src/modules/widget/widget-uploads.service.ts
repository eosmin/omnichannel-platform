import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import type { WidgetAttachment } from '@platform/channels/web-widget'
import { CacheKeys } from '@platform/core/cache'
import { WidgetLimits } from '@platform/core/domain'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  QUOTA_WINDOW_MS,
  sanitizeFilename,
  StorageKeys,
  type UploadUrlResult
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import {
  countWithinQuota,
  refuseTypeOrSize,
  uploadVerificationFailed
} from '../media/upload-checks'

import type { WidgetSite } from './widget-sites.service'
import type { WidgetUploadBody } from './widget.schemas'

// What the api wrote down when it signed the url. A visitor sends back only the id, so the name, the
// type and the size that count are these and never what comes with the message.
const recordSchema = z.object({
  visitorId: z.string(),
  key: z.string(),
  filename: z.string(),
  contentType: z.string(),
  fileSizeBytes: z.number().int().positive()
})

// The files of a web widget visitor (TDD_07 §6, TDD_10 §5.4). The visitor is anonymous, so the only
// authority is the token of the bootstrap: it names the site and the visitor, and an upload belongs to
// that visitor alone. A file goes to the same staging key as any upload, and the message that carries
// it hands the worker its id: the worker reads it like any file of a customer (checks, copy, scan).
@Injectable()
export class WidgetUploads {
  constructor(
    private readonly storage: StorageService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  async requestUrl(
    site: WidgetSite,
    visitorId: string,
    body: WidgetUploadBody
  ): Promise<Pick<UploadUrlResult, 'uploadUrl'> & { uploadId: string }> {
    refuseTypeOrSize(body.contentType, body.fileSizeBytes)
    // The visitor's counter first, the site's only for a request the visitor's let through: a visitor
    // who keeps asking after the refusal cannot use up the quota of the whole site
    const bucket = Math.floor(Date.now() / QUOTA_WINDOW_MS)
    await countWithinQuota(
      this.redis,
      CacheKeys.widgetUpload.visitorQuota(site.siteKey, visitorId, bucket),
      WidgetLimits.UPLOAD_URLS_PER_VISITOR_PER_HOUR
    )
    await countWithinQuota(
      this.redis,
      CacheKeys.widgetUpload.siteQuota(site.siteKey, bucket),
      WidgetLimits.UPLOAD_URLS_PER_SITE_PER_HOUR
    )

    const uploadId = crypto.randomUUID()
    const filename = sanitizeFilename(body.filename)
    const key = StorageKeys.messageUpload(site.storeId, uploadId, filename)
    const uploadUrl = await this.storage.uploadUrl({
      key,
      contentType: body.contentType,
      contentLength: body.fileSizeBytes
    })
    await this.redis.set(
      CacheKeys.widgetUpload.record(site.storeId, uploadId),
      JSON.stringify({
        visitorId,
        key,
        filename,
        contentType: body.contentType,
        fileSizeBytes: body.fileSizeBytes
      }),
      'EX',
      WidgetLimits.UPLOAD_TTL_SECONDS
    )
    return { uploadUrl, uploadId }
  }

  // The files a message carries, checked: each upload is one this visitor asked for, it is in the
  // bucket with the size and type that were signed, and it is not already part of another message.
  // Every failure is the same answer, so a visitor learns nothing about uploads that are not theirs.
  async attachmentsOf(
    site: WidgetSite,
    visitorId: string,
    clientMessageId: string,
    uploadIds: readonly string[]
  ): Promise<WidgetAttachment[]> {
    // Everything is checked before anything is claimed, so a message that fails leaves its files free
    // for the one the visitor sends next
    const ids = [...new Set(uploadIds)]
    const attachments = await Promise.all(
      ids.map(async uploadId => {
        const record = await this.recordOf(site.storeId, uploadId)
        if (record === null || record.visitorId !== visitorId) throw uploadVerificationFailed()
        const stored = await this.storage.head(record.key)
        if (
          stored === null ||
          stored.contentLength !== record.fileSizeBytes ||
          stored.contentType !== record.contentType
        ) {
          throw uploadVerificationFailed()
        }
        return { id: uploadId, filename: record.filename, contentType: record.contentType }
      })
    )
    // One after the other, so that a refusal leaves exactly the claims this message made to undo
    const claimed: string[] = []
    try {
      for (const uploadId of ids) {
        await this.claim(site.storeId, uploadId, clientMessageId)
        claimed.push(uploadId)
      }
    } catch (error) {
      await this.release(site.storeId, claimed, clientMessageId)
      throw error
    }
    return attachments
  }

  // Frees the files of a message that was not taken (the queue was down), so that the visitor can send
  // them again under another id. Only a claim this message holds is removed.
  async release(
    storeId: string,
    uploadIds: readonly string[],
    clientMessageId: string
  ): Promise<void> {
    for (const uploadId of uploadIds) {
      const key = CacheKeys.widgetUpload.claim(storeId, uploadId)
      if ((await this.redis.get(key)) === clientMessageId) await this.redis.del(key)
    }
  }

  private async recordOf(
    storeId: string,
    uploadId: string
  ): Promise<z.output<typeof recordSchema> | null> {
    const raw = await this.redis.get(CacheKeys.widgetUpload.record(storeId, uploadId))
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const record = recordSchema.safeParse(parsed)
    return record.success ? record.data : null
  }

  // A file is part of one message. Sending that message again (same id) finds its own claim; another
  // message with the same file is refused, so one upload is not copied into many messages.
  private async claim(storeId: string, uploadId: string, clientMessageId: string): Promise<void> {
    const key = CacheKeys.widgetUpload.claim(storeId, uploadId)
    const set = await this.redis.set(
      key,
      clientMessageId,
      'EX',
      WidgetLimits.UPLOAD_TTL_SECONDS,
      'NX'
    )
    if (set === 'OK') return
    if ((await this.redis.get(key)) !== clientMessageId) throw uploadVerificationFailed()
  }
}
