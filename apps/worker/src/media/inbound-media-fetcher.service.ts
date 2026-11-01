import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  errorName,
  withTimeout
} from '@platform/channels/connections'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, MediaStatus, OfActiveInstallation } from '@platform/core/domain'
import { type ErrorCode } from '@platform/core/errors'
import {
  type FetchInboundMediaJob,
  JobNames,
  QueueNames,
  type ScanFileJob
} from '@platform/core/queues'
import {
  AllAllowedContentTypes,
  MediaPurpose,
  refuseUpload,
  sanitizeFilename,
  StorageKeys,
  UploadLimits,
  maxBytesFor
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { refusalOf } from '../outbound/send-refusal'

import { inboundMediaId } from './inbound-media-id'
import { assertPublicHttpsUrl, UnsafeUrlError } from './public-url'

// What the retry sees of a failed attempt: the code and the name of the error, never its text (the
// error of a plugin can carry the token it was called with, and BullMQ keeps what is thrown)
export class MediaFetchAttemptFailed extends Error {
  constructor(code: ErrorCode, cause: unknown) {
    super(`fetching a customer file failed: ${code} (${errorName(cause)})`)
    this.name = 'MediaFetchAttemptFailed'
  }
}

class FileRefused extends Error {}

// What a file server says when it does not know: the type of the webhook is then the one taken
// A media id of a provider: letters, digits, underscore, dash. Anything else is read as a link.
const PLAIN_REFERENCE = /^[\w-]+$/

const GENERIC_TYPES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download'
])

// "image/jpeg; charset=x" is "image/jpeg"
const bareType = (contentType: string): string =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase()

async function readLimited(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += part.length
    if (total > maxBytes) {
      ;(stream as { destroy?: () => void }).destroy?.()
      throw new FileRefused('the file is bigger than the limit')
    }
    chunks.push(part)
  }
  return Buffer.concat(chunks)
}

// The worker half of a file the customer sent: asks the plugin of the connection that delivered the
// message for the bytes, keeps them in the bucket and hands them to the scan. The file is `pending`
// until the scan says otherwise, like any upload. Safe to run twice: one message and place, one media.
@Injectable()
export class InboundMediaFetcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InboundMediaFetcher.name)
  }

  // Throws when the attempt should be repeated; returns when the file is stored or will never be
  async fetch(job: FetchInboundMediaJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, messageId, index } = job
    const mediaId = inboundMediaId(messageId, index)

    // An earlier attempt got this far: only the scan may be missing
    const existing = await this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId },
      select: { status: true }
    })
    if (existing !== null) {
      if (existing.status === String(MediaStatus.PENDING)) await this.queueScan(mediaId)
      return
    }

    const [message, connection] = await Promise.all([
      this.prisma.client.message.findFirst({
        where: { id: messageId, storeId },
        select: { conversation: { select: { customerId: true } } }
      }),
      this.prisma.client.channelConnection.findFirst({
        where: {
          storeId,
          pluginId: job.pluginId,
          connectionId: job.connectionId,
          status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
          ...OfActiveInstallation
        },
        select: CONNECTION_ROW_SELECT
      })
    ])
    // Either is gone since the job was queued: there is nobody to give the file to
    if (message === null || connection === null) return

    const plugin = this.registry.find(connection.pluginId)
    if (plugin?.fetchMedia === undefined) {
      // A registry that is still filling is not a plugin that cannot fetch
      if (plugin === undefined && !isLastAttempt) {
        throw new Error('the plugin of the connection is not registered')
      }
      this.logger.warn(
        { pluginId: connection.pluginId, messageId },
        'the channel cannot fetch files'
      )
      return
    }

    let fetched: { body: Buffer; contentType: string } | null
    try {
      fetched = await this.download(plugin.fetchMedia.bind(plugin), connection, job)
    } catch (error) {
      if (error instanceof FileRefused || error instanceof UnsafeUrlError) {
        // The same answer on every try: the message keeps no file
        this.logger.warn(
          { messageId, index, reason: error.message },
          'a file of the customer was not kept'
        )
        return
      }
      const refused = refusalOf(error)
      this.logger.warn(
        {
          pluginId: connection.pluginId,
          messageId,
          code: refused.code,
          errorName: errorName(error)
        },
        'fetching a file of the customer failed'
      )
      // Also on the last attempt: the job then fails and reaches the dead-letter queue, where the loss
      // of a file is seen, instead of a success that kept nothing
      if (refused.retryable) throw new MediaFetchAttemptFailed(refused.code, error)
      return
    }
    if (fetched === null) return

    // The name is the customer's: it is cleaned where it is written, once, for the key and the row
    const filename = sanitizeFilename(job.filename ?? '')
    const key = StorageKeys.message(storeId, mediaId, filename)
    await this.storage.put(key, fetched.body, fetched.contentType)
    try {
      await this.prisma.client.media.create({
        data: {
          id: mediaId,
          storeId,
          purpose: MediaPurpose.MESSAGE,
          messageId,
          customerId: message.conversation.customerId,
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

  private async download(
    fetchMedia: NonNullable<ReturnType<PluginRegistry['find']>>['fetchMedia'] & object,
    connection: Parameters<ChannelContextFactory['contextFor']>[0],
    job: FetchInboundMediaJob
  ): Promise<{ body: Buffer; contentType: string } | null> {
    // What the timeout must stop: work that is still running after the job gave up would read the file
    // into memory with nobody waiting for it
    let cancelled = false
    let open: { destroy?: () => void } | undefined
    try {
      return await withTimeout(
        (async () => {
          // Anything that is not a plain id of the provider is a link, and is checked as one; the
          // plugin is given the address as the check read it, not the text that came in
          const ref = PLAIN_REFERENCE.test(job.mediaRef)
            ? job.mediaRef
            : (await assertPublicHttpsUrl(job.mediaRef)).href
          const file = await fetchMedia(this.contexts.contextFor(connection), ref)
          open = file.stream as { destroy?: () => void }
          if (cancelled) {
            open.destroy?.()
            throw new FileRefused('the fetch took too long')
          }
          const declared = bareType(file.contentType)
          const contentType = GENERIC_TYPES.has(declared) ? bareType(job.contentType) : declared
          if (!AllAllowedContentTypes.has(contentType)) {
            throw new FileRefused('the type of the file is not allowed')
          }
          const limit = maxBytesFor(contentType)
          if (file.contentLength !== null && file.contentLength > limit) {
            throw new FileRefused('the file is bigger than the limit')
          }
          const body = await readLimited(file.stream, limit)
          // The same rule as an upload, on the bytes that arrived
          if (refuseUpload(contentType, body.length) !== null) {
            throw new FileRefused('the file is bigger than the limit')
          }
          if (body.length === 0) throw new FileRefused('the file is empty')
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
