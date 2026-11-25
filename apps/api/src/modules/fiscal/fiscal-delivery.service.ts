import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  EventContext,
  isUniqueViolation,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  AuthorType,
  ChannelCapability,
  DeliveryStatus,
  FISCAL_DELIVERY_EMAIL_MAX_BYTES,
  FiscalDeliveryReason,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  FiscalResourceTypes,
  MediaStatus,
  MessageType
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { createTranslator } from '@platform/core/i18n-server'
import {
  ConversationsService,
  isHiddenStatus,
  lockConversationForWrite,
  OutboundQueue
} from '@platform/core/messaging'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'
import { MediaPurpose, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { FiscalEvidenceService } from '@platform/fiscal/runtime'
import { PluginRegistry } from '@platform/plugins/runtime'

import { channelFileLimits } from '../messages/channel-file-limits'
import { OrderMessagesService } from '../order-messages/order-messages.service'

// The two files a receiver is given with an accepted document, in the order they go
const FILE_KINDS = [FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE] as const
type FileKind = (typeof FILE_KINDS)[number]

// How long an email job that failed for good is kept (it holds the address and the files)
const EMAIL_FAILED_JOB_KEEP_SECONDS = 24 * 60 * 60

export const FiscalDeliveryOutcome = {
  SENT: 'sent',
  NOT_SENT: 'not_sent',
  // Nothing is owed: the document is not accepted any more, or its provider draws no representation
  SKIPPED: 'skipped',
  // The document was delivered already (this one asked twice)
  DUPLICATE: 'duplicate'
} as const
export type FiscalDeliveryOutcome =
  (typeof FiscalDeliveryOutcome)[keyof typeof FiscalDeliveryOutcome]

export interface DeliverFiscalDocumentInput {
  organizationId: string
  storeId: string
  documentId: string
}

// A file of the evidence of the document, as the row says it
interface EvidenceFile {
  kind: FileKind
  key: string
  filename: string
  contentType: string
  fileSize: number
}

interface Receiver {
  orderId: string
  orderNumber: string
  conversationId: string | null
  customerId: string
  storeName: string
  storeLocale: string
  customer: { email: string | null; locale: string | null; erasedAt: Date | null }
}

type Plan =
  | { route: typeof FiscalDeliveryRoute.NONE; reason: FiscalDeliveryReason }
  | { route: typeof FiscalDeliveryRoute.EMAIL }
  | { route: typeof FiscalDeliveryRoute.CHANNEL; conversationId: string }

const localeOf = (value: string | null): Locale =>
  SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE

// The files of an accepted fiscal document given to its receiver (the rule on delivering the files of a document): the signed file and its graphic
// representation, with the document, never held back for a payment. Where they go is decided by what the channel of the customer declares
// (documents, the types and the size it takes, an open window), never by its name (CLAUDE.md rule 13); when no channel takes both, the
// email with the two files attached; when neither can carry them, a row that says so and an alert for the people who manage the fiscal
// documents, who give them by hand. The text is fixed (i18n) and holds no advertising and no survey: it is not an order message, so no
// template of the store, no consent to those messages and no dispatch of them is involved.
@Injectable()
export class FiscalDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: EventContext,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly evidence: FiscalEvidenceService,
    private readonly orderMessages: OrderMessagesService,
    private readonly conversations: ConversationsService,
    private readonly registry: PluginRegistry,
    private readonly outbound: OutboundQueue,
    private readonly storage: StorageService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalDeliveryService.name)
  }

  async deliver(input: DeliverFiscalDocumentInput): Promise<FiscalDeliveryOutcome> {
    const { organizationId, documentId } = input
    const read = await this.inOrganization(organizationId, () => this.readOwed(input))
    if (read === 'skipped') return FiscalDeliveryOutcome.SKIPPED
    if (read === 'delivered') return FiscalDeliveryOutcome.DUPLICATE
    const receiver = read
    if (receiver.customer.erasedAt !== null) {
      return this.recordNotSent(input, receiver, FiscalDeliveryReason.CUSTOMER_ERASED)
    }
    // The files are made now when they are not there yet (a receiver is owed them with the document: waiting for a person to ask for them
    // is what the rule forbids). Both or none: a provider that draws no representation owes nothing of this kind.
    const made = await Promise.all(
      FILE_KINDS.map(kind => this.evidence.keep(organizationId, documentId, kind))
    )
    if (made.every(file => file === null)) return FiscalDeliveryOutcome.SKIPPED
    const files = await this.inOrganization(organizationId, () => this.filesOf(documentId))
    if (files === null) {
      return this.recordNotSent(input, receiver, FiscalDeliveryReason.FILES_UNAVAILABLE)
    }
    const plan = await this.inOrganization(organizationId, () =>
      this.plan(input.storeId, receiver, files)
    )
    if (plan.route === FiscalDeliveryRoute.NONE) {
      return this.recordNotSent(input, receiver, plan.reason)
    }
    return plan.route === FiscalDeliveryRoute.CHANNEL
      ? this.sendThroughChannel(input, receiver, files, plan.conversationId)
      : this.sendByEmail(input, receiver, files)
  }

  // A delivery that could not even be tried (the files of the event could not be read after every attempt): the person is told, so the
  // document is not left owing its files in silence.
  async recordFailure(input: DeliverFiscalDocumentInput): Promise<void> {
    const read = await this.inOrganization(input.organizationId, () => this.readOwed(input))
    if (read === 'skipped' || read === 'delivered') return
    await this.recordNotSent(input, read, FiscalDeliveryReason.FILES_UNAVAILABLE)
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Reading

  // What the delivery needs of the document and its order, or why nothing is owed: the document is not accepted any more (voided: the
  // invalidation is its own event), or it was delivered already
  private async readOwed(
    input: DeliverFiscalDocumentInput
  ): Promise<Receiver | 'skipped' | 'delivered'> {
    const { organizationId, documentId } = input
    const document = await this.prisma.client.fiscalDocument.findFirst({
      where: { id: documentId, organizationId },
      select: {
        status: true,
        storeId: true,
        orderId: true,
        delivery: { select: { id: true } },
        order: {
          select: {
            orderNumber: true,
            conversationId: true,
            customerId: true,
            store: { select: { name: true, defaultLocale: true } },
            customer: { select: { email: true, locale: true, erasedAt: true } }
          }
        }
      }
    })
    if (document === null || document.status !== String(FiscalDocumentStatus.ACCEPTED)) {
      return 'skipped'
    }
    if (document.delivery !== null) return 'delivered'
    const { order } = document
    return {
      orderId: document.orderId,
      orderNumber: order.orderNumber,
      conversationId: order.conversationId,
      customerId: order.customerId,
      storeName: order.store.name,
      storeLocale: order.store.defaultLocale,
      customer: order.customer
    }
  }

  // Both files as rows of evidence that can be given: a file the scan found infected or could not scan is never given
  private async filesOf(documentId: string): Promise<EvidenceFile[] | null> {
    const rows = await this.prisma.client.media.findMany({
      where: { fiscalDocumentId: documentId, fiscalEvidenceKind: { in: [...FILE_KINDS] } },
      select: {
        fiscalEvidenceKind: true,
        key: true,
        filename: true,
        contentType: true,
        fileSize: true,
        status: true
      }
    })
    const files: EvidenceFile[] = []
    for (const kind of FILE_KINDS) {
      const row = rows.find(candidate => candidate.fiscalEvidenceKind === String(kind))
      if (
        row === undefined ||
        row.status === String(MediaStatus.INFECTED) ||
        row.status === String(MediaStatus.UNSCANNABLE)
      ) {
        return null
      }
      files.push({
        kind,
        key: row.key,
        filename: row.filename,
        contentType: row.contentType,
        fileSize: row.fileSize
      })
    }
    return files
  }

  // Where the files go: the channel of the customer when it takes both (documents, these types, this size, an open window), the email
  // otherwise, and a reason when nothing is left
  private async plan(
    storeId: string,
    receiver: Receiver,
    files: readonly EvidenceFile[]
  ): Promise<Plan> {
    const found = await this.orderMessages.channelFor(storeId, receiver)
    if (found !== null && found.channel.windowOpen && this.channelTakes(found.pluginId, files)) {
      return { route: FiscalDeliveryRoute.CHANNEL, conversationId: found.conversationId }
    }
    const hasEmail = (receiver.customer.email ?? '').trim() !== ''
    if (!hasEmail)
      return { route: FiscalDeliveryRoute.NONE, reason: FiscalDeliveryReason.NO_CHANNEL }
    const total = files.reduce((sum, file) => sum + file.fileSize, 0)
    if (total > FISCAL_DELIVERY_EMAIL_MAX_BYTES) {
      return { route: FiscalDeliveryRoute.NONE, reason: FiscalDeliveryReason.TOO_LARGE }
    }
    return { route: FiscalDeliveryRoute.EMAIL }
  }

  // What the plugin declared about documents (CLAUDE.md rule 13): a channel with no rule for them lets one file through and the plugin
  // has the last word, so the check is of the capability and of the rule when there is one
  private channelTakes(pluginId: string, files: readonly EvidenceFile[]): boolean {
    if (!this.registry.hasCapability(pluginId, ChannelCapability.DOCUMENT)) return false
    const rule = channelFileLimits(this.registry, false)(pluginId, MessageType.DOCUMENT)
    if (rule === null) return true
    return files.every(
      file =>
        (rule.types === null || rule.types.includes(file.contentType)) &&
        file.fileSize <= rule.maxBytes
    )
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Writing

  // Two documents of the thread, one after the other, queued like any message of the platform. The bytes are copied to files of the order
  // (the evidence of a document cannot hang from a message) before the transaction, and removed if it does not commit.
  private async sendThroughChannel(
    input: DeliverFiscalDocumentInput,
    receiver: Receiver,
    files: readonly EvidenceFile[],
    conversationId: string
  ): Promise<FiscalDeliveryOutcome> {
    const { organizationId, storeId, documentId } = input
    const copies: { mediaId: string; key: string; file: EvidenceFile }[] = []
    try {
      for (const file of files) {
        const mediaId = randomUUID()
        const key = StorageKeys.order(storeId, receiver.orderId, mediaId, file.filename)
        const copied = await this.storage.copy(file.key, key)
        if (!copied) throw new Error('an evidence file to give is not in the bucket')
        copies.push({ mediaId, key, file })
      }
    } catch (error) {
      await this.discard(copies)
      this.logger.error(
        { documentId, err: errorName(error) },
        'the files of a fiscal document could not be copied to be sent'
      )
      return this.recordNotSent(input, receiver, FiscalDeliveryReason.FILES_UNAVAILABLE)
    }
    let committed: boolean
    try {
      committed = await this.inOrganization(organizationId, () =>
        this.prisma.transaction(async tx => {
          const current = await lockConversationForWrite(tx, storeId, conversationId)
          // Marked as spam or hidden since it was chosen: it carries nothing
          if (current.status === 'spam' || isHiddenStatus(current.status)) return false
          if (!(await this.claim(tx, input, receiver, FiscalDeliveryRoute.CHANNEL))) return false
          const base = Date.now()
          for (const [index, copy] of copies.entries()) {
            const at = new Date(base + index)
            const message = await tx.message.create({
              data: {
                storeId,
                conversationId,
                type: MessageType.DOCUMENT,
                content: null,
                authorType: AuthorType.SYSTEM,
                deliveryStatus: DeliveryStatus.QUEUED,
                createdAt: at
              },
              select: { id: true }
            })
            await tx.media.create({
              data: {
                id: copy.mediaId,
                storeId,
                purpose: MediaPurpose.ORDER,
                orderId: receiver.orderId,
                customerId: receiver.customerId,
                messageId: message.id,
                position: 0,
                deliveryStatus: DeliveryStatus.QUEUED,
                key: copy.key,
                filename: copy.file.filename,
                contentType: copy.file.contentType,
                fileSize: copy.file.fileSize,
                // Made by the platform from the row of the document: nothing a person uploaded, so nothing to scan
                status: MediaStatus.CLEAN,
                scannedAt: at,
                processedAt: at
              }
            })
            await this.conversations.recordMessageAt(tx, storeId, conversationId, at)
            this.events.publish(tx, Events.MESSAGE_QUEUED, {
              storeId,
              conversationId,
              messageId: message.id,
              authorId: null,
              clientMessageId: null,
              createdAt: at.toISOString(),
              visibility: { hidden: false, assignedTo: current.assignedTo }
            })
            this.queueAfterCommit(tx, storeId, message.id)
          }
          return true
        })
      )
    } catch (error) {
      // The files are removed only when the transaction is known not to have committed: another delivery of the same document that won
      // the unique row is a duplicate, and after a connection error the commit may have happened
      if (isUniqueViolation(error)) {
        await this.discard(copies)
        return FiscalDeliveryOutcome.DUPLICATE
      }
      throw error
    }
    if (!committed) {
      await this.discard(copies)
      // The conversation cannot carry them any more, or another delivery got there first: the first is a new try through the email
      const owed = await this.inOrganization(organizationId, () => this.readOwed(input))
      if (owed === 'delivered') return FiscalDeliveryOutcome.DUPLICATE
      if (owed === 'skipped') return FiscalDeliveryOutcome.SKIPPED
      return this.sendByEmailOrRecord(input, owed, files)
    }
    this.logSent(input, FiscalDeliveryRoute.CHANNEL)
    return FiscalDeliveryOutcome.SENT
  }

  // The email with the two files attached and only the information of the delivery: no advertising and no survey. The job is
  // queued first under an id made from the document, and the row is written after it: a process that dies in between leaves a job that
  // a second try adds once (the id), never a receiver who was not told and nobody who knows.
  private async sendByEmail(
    input: DeliverFiscalDocumentInput,
    receiver: Receiver,
    files: readonly EvidenceFile[]
  ): Promise<FiscalDeliveryOutcome> {
    const { organizationId, storeId, documentId } = input
    const to = (receiver.customer.email ?? '').trim()
    const attachments: NonNullable<SendEmailJob['attachments']> = []
    for (const file of files) {
      const bytes = await this.storage.read(file.key, FISCAL_DELIVERY_EMAIL_MAX_BYTES)
      if (bytes === null) {
        this.logger.error(
          { documentId },
          'a file of a fiscal document to send is not in the bucket'
        )
        return this.recordNotSent(input, receiver, FiscalDeliveryReason.FILES_UNAVAILABLE)
      }
      attachments.push({
        filename: file.filename,
        contentBase64: bytes.toString('base64'),
        contentType: file.contentType
      })
    }
    const locale = localeOf(receiver.customer.locale ?? receiver.storeLocale)
    await this.emailQueue.add(
      JobNames.SEND_EMAIL,
      {
        template: EmailTemplates.ORDER_MESSAGE,
        to,
        locale,
        data: {
          storeName: receiver.storeName,
          orderNumber: receiver.orderNumber,
          text: createTranslator(locale, 'fiscalDelivery')('text', {
            order: receiver.orderNumber,
            store: receiver.storeName
          })
        },
        attachments,
        tags: { storeId, template: EmailTemplates.ORDER_MESSAGE }
      },
      // The job holds the address and the files of the receiver: once sent it has no reason to stay, and one that failed for good is kept
      // for a day for whoever looks at it
      {
        removeOnComplete: true,
        removeOnFail: { age: EMAIL_FAILED_JOB_KEEP_SECONDS },
        jobId: `fiscal-delivery-${documentId}`
      }
    )
    try {
      const claimed = await this.inOrganization(organizationId, () =>
        this.prisma.transaction(tx => this.claim(tx, input, receiver, FiscalDeliveryRoute.EMAIL))
      )
      if (!claimed) return FiscalDeliveryOutcome.DUPLICATE
    } catch (error) {
      if (isUniqueViolation(error)) return FiscalDeliveryOutcome.DUPLICATE
      throw error
    }
    this.logSent(input, FiscalDeliveryRoute.EMAIL)
    return FiscalDeliveryOutcome.SENT
  }

  // The conversation vanished between the decision and the write: the email is the way left, or the reason
  private async sendByEmailOrRecord(
    input: DeliverFiscalDocumentInput,
    receiver: Receiver,
    files: readonly EvidenceFile[]
  ): Promise<FiscalDeliveryOutcome> {
    if ((receiver.customer.email ?? '').trim() === '') {
      return this.recordNotSent(input, receiver, FiscalDeliveryReason.NO_CHANNEL)
    }
    const total = files.reduce((sum, file) => sum + file.fileSize, 0)
    if (total > FISCAL_DELIVERY_EMAIL_MAX_BYTES) {
      return this.recordNotSent(input, receiver, FiscalDeliveryReason.TOO_LARGE)
    }
    return this.sendByEmail(input, receiver, files)
  }

  // Nothing could carry the files: the row says why, and the people who manage the fiscal documents are told (except when the customer
  // was erased on purpose: nobody is left to give them to, and nothing went wrong)
  private async recordNotSent(
    input: DeliverFiscalDocumentInput,
    receiver: Receiver,
    reason: FiscalDeliveryReason
  ): Promise<FiscalDeliveryOutcome> {
    const { organizationId, storeId, documentId } = input
    let claimed: boolean
    try {
      claimed = await this.inOrganization(organizationId, () =>
        this.prisma.transaction(async tx => {
          const made = await this.claim(tx, input, receiver, FiscalDeliveryRoute.NONE, reason)
          if (made && reason !== FiscalDeliveryReason.CUSTOMER_ERASED) {
            this.events.publish(tx, Events.FISCAL_DELIVERY_NOT_SENT, {
              organizationId,
              storeId,
              documentId,
              orderId: receiver.orderId,
              reason
            })
          }
          return made
        })
      )
    } catch (error) {
      if (isUniqueViolation(error)) return FiscalDeliveryOutcome.DUPLICATE
      throw error
    }
    if (!claimed) return FiscalDeliveryOutcome.DUPLICATE
    this.audit.log({
      action: AuditAction.FISCAL_DELIVERY_NOT_SENT,
      actor: { system: true },
      storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: documentId,
      metadata: { reason }
    })
    return FiscalDeliveryOutcome.NOT_SENT
  }

  // The first writer of a document wins (the unique key of the document): false when it was delivered already
  private async claim(
    tx: PrismaTransaction,
    input: DeliverFiscalDocumentInput,
    receiver: Receiver,
    route: FiscalDeliveryRoute,
    reason: FiscalDeliveryReason | null = null
  ): Promise<boolean> {
    const { count } = await tx.fiscalDelivery.createMany({
      data: [
        {
          organizationId: input.organizationId,
          storeId: input.storeId,
          documentId: input.documentId,
          orderId: receiver.orderId,
          status:
            route === FiscalDeliveryRoute.NONE
              ? FiscalDeliveryStatus.NOT_SENT
              : FiscalDeliveryStatus.SENT,
          route,
          reason
        }
      ],
      skipDuplicates: true
    })
    return count === 1
  }

  private queueAfterCommit(tx: PrismaTransaction, storeId: string, messageId: string): void {
    this.prisma.afterCommit(tx, () => {
      this.outbound.enqueue({ storeId, messageId }).catch((error: unknown) => {
        this.logger.warn(
          { messageId, errorName: errorName(error) },
          'a fiscal delivery message could not be queued; the sweep will'
        )
      })
    })
  }

  private async discard(copies: readonly { key: string }[]): Promise<void> {
    for (const copy of copies) {
      try {
        await this.storage.delete(copy.key)
      } catch {
        // A stray object is found by its prefix by the storage cleanup; it is not worth failing a delivery that already failed
      }
    }
  }

  private logSent(input: DeliverFiscalDocumentInput, route: FiscalDeliveryRoute): void {
    this.audit.log({
      action: AuditAction.FISCAL_DELIVERY_SENT,
      actor: { system: true },
      storeId: input.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: input.documentId,
      metadata: { route }
    })
  }

  private inOrganization<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.context.inOrganization(organizationId, work)
  }
}
