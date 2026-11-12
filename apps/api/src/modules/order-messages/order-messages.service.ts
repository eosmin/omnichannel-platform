import { createHash, randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ConsentPurposes } from '@platform/core/compliance'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  AuthorType,
  ChannelConnectionStatus,
  ConversationStatus,
  DeliveryStatus,
  isInstallationActive,
  MediaStatus,
  MessageLimits,
  MessageType,
  OrderMessageKind,
  type OrderMessageKindType,
  type OrderMessageAlertReason,
  type OrderMessageNotSentReason,
  OrderMessageOutcomeStatus,
  OrderMessageNotSentReasons,
  type OrderMessageRoute,
  OrderMessageTriggers,
  OrderMessageRoutes,
  type OrderMessageTrigger,
  OrderResourceTypes,
  ShipmentInactiveStatuses,
  ShipmentKind
} from '@platform/core/domain'
import { ErrorCodes, errorName, PlatformException, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import {
  ConversationsService,
  isHiddenStatus,
  lockConversationForWrite,
  MessagingWindowService,
  OutboundQueue
} from '@platform/core/messaging'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'
import {
  buildOrderMessageValues,
  channelTemplateValues,
  decideOrderMessageRoute,
  type OrderMessageChannel,
  type OrderMessageSource,
  type OrderMessageValues,
  orderMessageSourceOf,
  renderOrderMessage,
  renderOrderSummaryPdf
} from '@platform/core/shipping'
import { MediaPurpose, sanitizeFilename, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import { ChannelTemplatesService } from '../channels/channel-templates.service'
import { channelFileLimits } from '../messages/channel-file-limits'

import { OrderTemplatesService } from './order-templates.service'
import type { OrderTemplateView } from './order-templates.support'

// What a caller asks: a message of a kind about an order. The key says which send this is, so that asking twice sends once
// (`automaticDispatchKey`, `manualDispatchKey`, `pressedDispatchKey` of the shipping library).
export interface SendOrderMessageInput {
  storeId: string
  orderId: string
  kind: OrderMessageKindType
  trigger: OrderMessageTrigger
  idempotencyKey: string
  // The package that caused the message: its guide, carrier and attempts fill the variables. Left out, the order's live
  // outbound package is the one (a person sending the shipped message by hand)
  shipmentId?: string | undefined
  // The member who asked; null for the platform
  requestedBy: string | null
  // An automatic message of a kind whose template says whether it goes by itself (`autoSend`): with this, a template that is not set
  // to go, or none at all, sends nothing and records nothing (the store never asked for it)
  onlyIfAutoSend?: boolean | undefined
}

export type OrderMessageOutcome =
  | {
      status: typeof OrderMessageOutcomeStatus.SENT
      route:
        | typeof OrderMessageRoutes.CHANNEL_TEXT
        | typeof OrderMessageRoutes.CHANNEL_TEMPLATE
        | typeof OrderMessageRoutes.EMAIL
      messageId: string | null
    }
  | { status: typeof OrderMessageOutcomeStatus.NOT_SENT; reason: OrderMessageNotSentReason }
  | { status: typeof OrderMessageOutcomeStatus.SKIPPED }
  // The key had been used: nothing was sent now, and what was done then is what the answer says, so that a retry after a lost
  // response learns whether it went
  | {
      status: typeof OrderMessageOutcomeStatus.DUPLICATE
      route: OrderMessageRoute
      reason: OrderMessageNotSentReason | null
      messageId: string | null
    }

export type OrderMessagePreviewResult =
  | { ok: true; text: string; locale: Locale }
  | { ok: false; reason: OrderMessageNotSentReason; missing: string[] }

// A deliberate stop (the customer was forgotten, or withdrew their consent) is recorded and shown in the timeline but never
// raises an alert: nothing went wrong, and nobody should retry it
const SILENT_REASONS: ReadonlySet<OrderMessageAlertReason> = new Set([
  OrderMessageNotSentReasons.CUSTOMER_ERASED,
  OrderMessageNotSentReasons.CONSENT_REVOKED
])

const SYSTEM = { type: 'system', id: null } as const

const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  conversationId: true,
  customerId: true,
  totalCents: true,
  currency: true,
  shippingAddress: true,
  scheduledDeliveryDate: true,
  trackingNumber: true,
  store: { select: { name: true, defaultLocale: true } },
  customer: { select: { name: true, email: true, locale: true, erasedAt: true } },
  items: {
    select: { productName: true, variantName: true, quantity: true, unitPriceCents: true },
    orderBy: { id: 'asc' }
  }
} as const

const CONVERSATION_SELECT = {
  id: true,
  channelType: true,
  status: true,
  channelConnection: {
    select: {
      pluginId: true,
      status: true,
      installation: { select: { status: true, plugin: { select: { status: true } } } }
    }
  }
} as const

// How many of the customer's recent conversations are looked at when the order has none of its own
const FALLBACK_CONVERSATIONS = 5

const SUMMARY_CONTENT_TYPE = 'application/pdf'

// How long an email job that failed for good is kept (it holds the address and the text of the message)
const EMAIL_FAILED_JOB_KEEP_SECONDS = 24 * 60 * 60

const localeOf = (value: string | null): Locale =>
  SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE

// What the decision hands to the writer: where, and with what text. A channel route always has its conversation and its text,
// the template one also the approved template it fills; the email route the address.
type Decision =
  | { route: typeof OrderMessageRoutes.NOT_SENT; reason: OrderMessageNotSentReason }
  | { route: typeof OrderMessageRoutes.EMAIL; text: string; email: string }
  | {
      route: typeof OrderMessageRoutes.CHANNEL_TEXT
      text: string
      conversationId: string
      // The order summary drawn as a PDF, when the template asks for it and the channel takes documents (TDD_17 §4.7)
      summaryPdf?: Uint8Array
    }
  | {
      route: typeof OrderMessageRoutes.CHANNEL_TEMPLATE
      text: string
      conversationId: string
      channelTemplate: { name: string; language: string; variables: string[] }
    }
type ChannelDecision = Extract<
  Decision,
  { route: typeof OrderMessageRoutes.CHANNEL_TEXT | typeof OrderMessageRoutes.CHANNEL_TEMPLATE }
>

// What the select of a conversation reads of it: the channel it is on and whether that connection can carry anything
interface ConversationForMessage {
  id: string
  channelType: string
  status: string
  channelConnection: {
    pluginId: string
    status: string
    installation: { status: string; plugin: { status: string } }
  }
}

// A summary put in the bucket and not yet written down
interface StoredSummary {
  mediaId: string
  key: string
  filename: string
  byteLength: number
}

interface FoundChannel {
  conversationId: string
  pluginId: string
  channel: Omit<OrderMessageChannel, 'template'>
  textMaxLength: number | null
}

// The messages a store sends about an order (TDD_17 §4.7). The template says what, the order says with which values, and
// what the channel of the conversation DECLARES says how: free text at any time for a channel with no window, inside the window
// otherwise, the approved template linked to the template outside it, the email fallback when there is none, and a reason that
// the team sees when nothing is left. Never by the name of a plugin (CLAUDE.md rule 13), and never dropped without a trace.
@Injectable()
export class OrderMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly templates: OrderTemplatesService,
    private readonly channelTemplates: ChannelTemplatesService,
    private readonly conversations: ConversationsService,
    private readonly window: MessagingWindowService,
    private readonly registry: PluginRegistry,
    private readonly outbound: OutboundQueue,
    private readonly storage: StorageService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OrderMessagesService.name)
  }

  // The message as the customer would read it, from the real order: nothing is sent and nothing is written
  async preview(
    storeId: string,
    orderId: string,
    kind: OrderMessageKindType,
    shipmentId?: string
  ): Promise<OrderMessagePreviewResult> {
    const order = await this.loadOrder(storeId, orderId)
    // What send would refuse before it renders anything is refused here too, so the preview never promises a message that
    // would not go
    const stop = await this.customerStop(storeId, order)
    if (stop !== null) return { ok: false, reason: stop, missing: [] }
    const template = await this.templates.resolve(storeId, kind, order.customer.locale)
    if (template === null) {
      return { ok: false, reason: OrderMessageNotSentReasons.NO_TEMPLATE, missing: [] }
    }
    const { text } = await this.renderFor(storeId, order, template, shipmentId)
    return text.ok
      ? { ok: true, text: text.text, locale: localeOf(template.locale) }
      : {
          ok: false,
          reason: text.reason,
          missing: text.reason === OrderMessageNotSentReasons.MISSING_VARIABLE ? text.missing : []
        }
  }

  async send(input: SendOrderMessageInput): Promise<OrderMessageOutcome> {
    const { storeId, orderId, kind } = input
    // A repeated event or request finds its earlier answer: the check before the work spares the provider a call, the
    // unique key under the claim is what makes it true when two arrive at once
    const earlier = await this.storedOutcome(storeId, input.idempotencyKey)
    if (earlier !== null) return earlier

    const order = await this.loadOrder(storeId, orderId)
    const template = await this.templates.resolve(storeId, kind, order.customer.locale)
    // What was not asked for is not done and not recorded: a store that never set its messages up is not alerted at every status
    if (input.onlyIfAutoSend === true && (template === null || !template.autoSend)) {
      return { status: OrderMessageOutcomeStatus.SKIPPED }
    }
    const stop = await this.customerStop(storeId, order)
    if (stop !== null) return this.recordNotSent(input, order, stop, null)
    if (template === null) {
      return this.recordNotSent(input, order, OrderMessageNotSentReasons.NO_TEMPLATE, null)
    }
    const decision = await this.decide(input, order, template)
    switch (decision.route) {
      case OrderMessageRoutes.NOT_SENT:
        return this.recordNotSent(input, order, decision.reason, template.locale)
      case OrderMessageRoutes.EMAIL:
        return this.sendEmail(input, order, template.locale, decision)
      default:
        return this.sendThroughChannel(input, order, template.locale, decision)
    }
  }

  // A send that kept failing for a cause that may pass (the provider did not answer, the queue was down) after the retries of the
  // caller: nothing is claimed, so a later event of the same shipment sends it, and the team is told now, because a customer who
  // is not told is something somebody should know
  async alertNotSent(input: SendOrderMessageInput, reason: OrderMessageAlertReason): Promise<void> {
    const order = await this.loadOrder(input.storeId, input.orderId)
    // The event leaves with the commit of an empty transaction, as every event of the platform does
    await this.prisma.transaction(tx => {
      this.announceNotSent(tx, input, order, reason)
      return Promise.resolve()
    })
    this.logNotSent(input, order, reason)
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Deciding

  private async decide(
    input: SendOrderMessageInput,
    order: LoadedOrder,
    template: OrderTemplateView
  ): Promise<Decision> {
    const { storeId } = input
    const email = (order.customer.email ?? '').trim()
    // The text is the body of the template alone: the variables that fill the approved template are checked apart, so an order
    // that lacks one of them can still be told in free text or by email. Rendered first: a message that cannot be written
    // does not need a channel looked for (carrier events are the hot path)
    const rendered = await this.renderFor(storeId, order, template, input.shipmentId)
    if (!rendered.text.ok) {
      this.logger.info(
        { orderId: order.id, kind: input.kind, reason: rendered.text.reason },
        'an order message was not rendered'
      )
      return { route: OrderMessageRoutes.NOT_SENT, reason: rendered.text.reason }
    }
    const text = rendered.text.text
    const found = await this.findChannel(storeId, order)
    const link = template.channelTemplate
    // The linked template counts only for the channel of the plugin it was linked for, and only while that plugin still
    // declares what makes a template usable (TDD_17 §4.7): a link is stored once and read later
    const linkApplies =
      found !== null &&
      link !== null &&
      found.channel.takesTemplates &&
      found.channel.hasWindow &&
      !found.channel.windowOpen &&
      link.pluginId === found.pluginId
    const byEmail = (): Decision => ({ route: OrderMessageRoutes.EMAIL, text, email })

    // No conversation can carry it: the email, or the reason
    if (found === null) {
      const route = decideOrderMessageRoute({ channel: null, hasEmail: email !== '' })
      return route.route === OrderMessageRoutes.NOT_SENT ? route : byEmail()
    }

    let channelTemplate: { name: string; language: string; variables: string[] } | undefined
    let templateState: OrderMessageChannel['template'] = 'none'
    let approvedText: string | undefined
    if (linkApplies && link !== null) {
      const values = channelTemplateValues(link.variables, rendered.values)
      // The worker holds each value to what a provider takes in a variable (MessageLimits): a longer one would be stored and
      // then fail for good in the thread, so the template is not usable for this order
      const fits =
        values.ok &&
        values.values.every(
          value => Array.from(value).length <= MessageLimits.TEMPLATE_VARIABLE_MAX_LENGTH
        )
      if (values.ok && fits) {
        const variables = values.values
        try {
          const approved = await this.channelTemplates.renderForSystem(
            storeId,
            found.conversationId,
            { name: link.name, language: link.language, variables }
          )
          approvedText = approved.content
          channelTemplate = { name: link.name, language: link.language, variables }
          templateState = 'usable'
        } catch (error) {
          // The provider could not be asked (it timed out, or answered with an error): that may pass, so nothing is claimed and
          // the caller asks again, instead of a message that is never sent because of a blip
          if (
            !(error instanceof PlatformException) ||
            error.code === ErrorCodes.CHANNEL_MESSAGE_FAILED
          ) {
            throw error
          }
          // Only an answer of ours that says the template cannot be used counts as that (it is not listed, not approved, does not
          // match its placeholders, its connection is unusable): the same as no template, with a reason when nothing else is left.
          // Any other failure is not known to be permanent, so it throws like the provider that did not answer
          templateState = 'unusable'
          this.logger.warn(
            {
              orderId: order.id,
              kind: input.kind,
              code: codeOf(error),
              errorName: errorName(error)
            },
            'the approved template of an order message cannot be used'
          )
        }
      } else {
        templateState = 'unusable'
      }
    }

    const decision = decideOrderMessageRoute({
      channel: { ...found.channel, template: templateState },
      hasEmail: email !== ''
    })
    if (decision.route === OrderMessageRoutes.NOT_SENT) return decision
    if (decision.route === OrderMessageRoutes.EMAIL) return byEmail()
    if (decision.route === OrderMessageRoutes.CHANNEL_TEMPLATE && channelTemplate !== undefined) {
      return {
        route: OrderMessageRoutes.CHANNEL_TEMPLATE,
        text: approvedText ?? text,
        conversationId: found.conversationId,
        channelTemplate
      }
    }
    // Free text: held to what the channel holds before anything exists, so a text that can never go is said now (and not as
    // a message that failed for good in the thread). The customer who has an address is told by email instead.
    if (found.textMaxLength !== null && Array.from(text).length > found.textMaxLength) {
      return email === ''
        ? { route: OrderMessageRoutes.NOT_SENT, reason: OrderMessageNotSentReasons.TOO_LONG }
        : byEmail()
    }
    const summaryPdf =
      input.kind === OrderMessageKind.ORDER_SUMMARY && template.attachSummary
        ? await this.summaryDocument(found, rendered.source, template.locale, order.id)
        : undefined
    return {
      route: OrderMessageRoutes.CHANNEL_TEXT,
      text,
      conversationId: found.conversationId,
      ...(summaryPdf === undefined ? {} : { summaryPdf })
    }
  }

  // The summary as a PDF for the channel to carry along (TDD_17 §4.7): only when the plugin declares documents and takes a PDF of
  // this size. The text always goes, so a channel without them, or a document that cannot be drawn, loses only the attachment.
  private async summaryDocument(
    found: FoundChannel,
    source: OrderMessageSource,
    templateLocale: string,
    orderId: string
  ): Promise<Uint8Array | undefined> {
    if (!this.registry.hasCapability(found.pluginId, ChannelCapability.DOCUMENT)) return undefined
    const rule = channelFileLimits(this.registry, false)(found.pluginId, MessageType.DOCUMENT)
    if (rule !== null && rule.types !== null && !rule.types.includes(SUMMARY_CONTENT_TYPE)) {
      return undefined
    }
    try {
      const pdf = await renderOrderSummaryPdf(source, localeOf(templateLocale))
      return rule !== null && pdf.byteLength > rule.maxBytes ? undefined : pdf
    } catch (error) {
      this.logger.warn(
        { orderId, errorName: errorName(error) },
        'the summary of an order could not be drawn; the text goes without it'
      )
      return undefined
    }
  }

  private async renderFor(
    storeId: string,
    order: LoadedOrder,
    template: OrderTemplateView,
    shipmentId: string | undefined
  ): Promise<{
    text: ReturnType<typeof renderOrderMessage>
    values: OrderMessageValues
    source: OrderMessageSource
  }> {
    const shipment = await this.shipmentOf(storeId, order.id, shipmentId, template.kind)
    const source = orderMessageSourceOf({
      orderNumber: order.orderNumber,
      totalCents: order.totalCents,
      currency: order.currency,
      shippingAddress: order.shippingAddress,
      scheduledDeliveryDate: order.scheduledDeliveryDate,
      trackingNumber: order.trackingNumber,
      storeName: order.store.name,
      customerName: order.customer.name,
      items: order.items,
      shipment
    })
    const values = buildOrderMessageValues(source, localeOf(template.locale))
    return { text: renderOrderMessage(template.body, values), values, source }
  }

  // The conversation the message goes through (TDD_17 §4.7): the order's own, otherwise the customer's most recent open one,
  // otherwise none (the email fallback). One that cannot carry a message (spam, hidden, a connection let go, a plugin that is
  // gone or not offered to the store) is skipped, not an error. One that can carry it but whose window is closed gives way to
  // another one whose window is open (free text beats a template or an email), and is the answer when there is none.
  private async findChannel(storeId: string, order: LoadedOrder): Promise<FoundChannel | null> {
    let closed: FoundChannel | null = null
    const own =
      order.conversationId === null
        ? []
        : await this.prisma.client.conversation.findMany({
            where: { id: order.conversationId, storeId },
            select: CONVERSATION_SELECT
          })
    for (const conversation of own) {
      const found = await this.channelOf(storeId, conversation)
      if (found?.channel.windowOpen === true) return found
      closed ??= found
    }
    // Only when the order's own conversation cannot take free text now
    const others = await this.prisma.client.conversation.findMany({
      where: {
        storeId,
        customerId: order.customerId,
        status: ConversationStatus.OPEN,
        ...(order.conversationId === null ? {} : { id: { not: order.conversationId } })
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      take: FALLBACK_CONVERSATIONS,
      select: CONVERSATION_SELECT
    })
    for (const conversation of others) {
      const found = await this.channelOf(storeId, conversation)
      if (found?.channel.windowOpen === true) return found
      closed ??= found
    }
    return closed
  }

  private async channelOf(
    storeId: string,
    conversation: ConversationForMessage
  ): Promise<FoundChannel | null> {
    const carrier = this.carrierOf(storeId, conversation)
    if (carrier === null) return null
    const { policy, pluginId } = carrier
    // A channel with no window is open at any time: asking is for the ones that have one
    const open =
      policy === null
        ? true
        : await this.window.isOpen(this.prisma.client, storeId, conversation.id)
    return {
      conversationId: conversation.id,
      pluginId,
      channel: {
        hasWindow: policy !== null,
        windowOpen: open,
        takesTemplates:
          policy?.requiresTemplateWhenClosed === true &&
          this.registry.hasCapability(pluginId, ChannelCapability.TEMPLATES)
      },
      textMaxLength: this.registry.limitsOf(conversation.channelType)?.textMaxLength ?? null
    }
  }

  private carrierOf(
    storeId: string,
    conversation: ConversationForMessage
  ): { pluginId: string; policy: ReturnType<typeof policyOf> } | null {
    if (
      conversation.status === String(ConversationStatus.SPAM) ||
      isHiddenStatus(conversation.status)
    ) {
      return null
    }
    const { channelConnection: connection } = conversation
    if (
      connection.status === String(ChannelConnectionStatus.DISCONNECTED) ||
      !isInstallationActive(connection.installation) ||
      !this.registry.isVisibleTo(connection.pluginId, storeId)
    ) {
      return null
    }
    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) return null
    return { pluginId: connection.pluginId, policy: policyOf(plugin) }
  }

  // A customer who was erased or who withdrew their consent is not written to (`TDD_05 §10`). Having no record is not a
  // refusal: the messages about an order rest on the contract, and the platform has no flow yet that records a consent
  // (Step 7.2), so the only record there can be is a refusal.
  private async customerStop(
    storeId: string,
    order: LoadedOrder
  ): Promise<OrderMessageNotSentReason | null> {
    if (order.customer.erasedAt !== null) return OrderMessageNotSentReasons.CUSTOMER_ERASED
    const latest = await this.prisma.client.consentRecord.findFirst({
      where: { storeId, customerId: order.customerId, purpose: ConsentPurposes.ORDER_MESSAGES },
      orderBy: { createdAt: 'desc' },
      select: { granted: true, revokedAt: true }
    })
    if (latest !== null && (!latest.granted || latest.revokedAt !== null)) {
      return OrderMessageNotSentReasons.CONSENT_REVOKED
    }
    return null
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Writing

  private async sendThroughChannel(
    input: SendOrderMessageInput,
    order: LoadedOrder,
    locale: string,
    decision: ChannelDecision
  ): Promise<OrderMessageOutcome> {
    const { storeId } = input
    const { conversationId, route } = decision
    // The document goes into the bucket before the transaction (the object store is not asked inside one) and is removed if the
    // message is not written after all
    const document =
      decision.route === OrderMessageRoutes.CHANNEL_TEXT && decision.summaryPdf !== undefined
        ? await this.putSummary(storeId, order, decision.summaryPdf)
        : null
    let messageId: string | null
    try {
      messageId = await this.prisma.transaction(async tx => {
        // The conversation first, as every write of a message does (the lock order of the thread)
        const current = await lockConversationForWrite(tx, storeId, conversationId)
        // The state that decided the channel was read before this lock: a conversation marked as spam or hidden in between
        // carries nothing, and the realtime event below must not show a thread that is hidden
        if (current.status === String(ConversationStatus.SPAM) || isHiddenStatus(current.status)) {
          throw resourceNotFound('conversation')
        }
        const id = randomUUID()
        const claimed = await this.claim(tx, input, route, null, locale, id)
        if (!claimed) return null
        const now = new Date()
        const row = await tx.message.create({
          data: {
            id,
            storeId,
            conversationId,
            type:
              route === OrderMessageRoutes.CHANNEL_TEMPLATE
                ? MessageType.TEMPLATE
                : MessageType.TEXT,
            content: decision.text,
            authorType: AuthorType.SYSTEM,
            // The template message keeps what the worker needs to send it by name; both keep what they are about
            metadata: {
              ...(decision.route === OrderMessageRoutes.CHANNEL_TEMPLATE
                ? { template: decision.channelTemplate }
                : {}),
              orderMessage: { orderId: order.id, kind: input.kind }
            },
            idempotencyKey: input.idempotencyKey,
            deliveryStatus: DeliveryStatus.QUEUED,
            createdAt: now
          },
          select: { id: true }
        })
        // The thread moves up the inbox; it is not a reply of the team (no first response, nothing reopened)
        await this.conversations.recordMessageAt(tx, storeId, conversationId, now)
        this.events.publish(tx, Events.MESSAGE_QUEUED, {
          storeId,
          conversationId,
          messageId: row.id,
          authorId: null,
          clientMessageId: null,
          createdAt: now.toISOString(),
          visibility: { hidden: false, assignedTo: current.assignedTo }
        })
        this.queueAfterCommit(tx, storeId, row.id)
        if (document !== null) {
          await this.writeSummaryDocument(tx, {
            storeId,
            conversationId,
            order,
            kind: input.kind,
            document,
            at: new Date(now.getTime() + 1),
            assignedTo: current.assignedTo
          })
        }
        return row.id
      })
    } catch (error) {
      // Removed only when the transaction is known not to have committed (it stopped on the conversation): after a connection error
      // the commit may have happened, and then the file is the one the queued message reads. A stray object is found by its prefix.
      if (
        document !== null &&
        error instanceof PlatformException &&
        error.code === ErrorCodes.RESOURCE_NOT_FOUND
      ) {
        await this.discardSummary(document.key)
      }
      // The conversation vanished between the decision and the write: nobody is left to carry it
      if (error instanceof PlatformException && error.code === ErrorCodes.RESOURCE_NOT_FOUND) {
        return this.recordNotSent(input, order, OrderMessageNotSentReasons.NO_CHANNEL, locale)
      }
      throw error
    }
    if (messageId === null) {
      if (document !== null) await this.discardSummary(document.key)
      return this.duplicateOf(input)
    }
    this.logSent(input, order, route)
    return { status: OrderMessageOutcomeStatus.SENT, route, messageId }
  }

  private queueAfterCommit(tx: PrismaTransaction, storeId: string, messageId: string): void {
    this.prisma.afterCommit(tx, () => {
      this.outbound.enqueue({ storeId, messageId }).catch((error: unknown) => {
        this.logger.warn(
          { messageId, errorName: errorName(error) },
          'an order message could not be queued; the sweep will'
        )
      })
    })
  }

  // The summary of the order as a file of the store (purpose ORDER): drawn by the platform, so it needs no scan
  private async putSummary(
    storeId: string,
    order: LoadedOrder,
    pdf: Uint8Array
  ): Promise<StoredSummary | null> {
    const mediaId = randomUUID()
    const filename = sanitizeFilename(`${order.orderNumber}.pdf`)
    const key = StorageKeys.order(storeId, order.id, mediaId, filename)
    try {
      await this.storage.put(key, Buffer.from(pdf), SUMMARY_CONTENT_TYPE)
    } catch (error) {
      // The text goes without it
      this.logger.warn(
        { orderId: order.id, errorName: errorName(error) },
        'the summary of an order could not be stored; the text goes without it'
      )
      return null
    }
    return { mediaId, key, filename, byteLength: pdf.byteLength }
  }

  private async discardSummary(key: string): Promise<void> {
    try {
      await this.storage.delete(key)
    } catch {
      // A stray object is found by its prefix by the storage cleanup; it is not worth failing a message that already failed
    }
  }

  // The second message of the summary: the file, a document of the thread right after the text, queued like it
  private async writeSummaryDocument(
    tx: PrismaTransaction,
    input: {
      storeId: string
      conversationId: string
      order: LoadedOrder
      kind: OrderMessageKindType
      document: StoredSummary
      at: Date
      assignedTo: string | null
    }
  ): Promise<void> {
    const { storeId, conversationId, order, document, at } = input
    const message = await tx.message.create({
      data: {
        storeId,
        conversationId,
        type: MessageType.DOCUMENT,
        content: null,
        authorType: AuthorType.SYSTEM,
        metadata: { orderMessage: { orderId: order.id, kind: input.kind, attachment: true } },
        deliveryStatus: DeliveryStatus.QUEUED,
        createdAt: at
      },
      select: { id: true }
    })
    await tx.media.create({
      data: {
        id: document.mediaId,
        storeId,
        purpose: MediaPurpose.ORDER,
        orderId: order.id,
        customerId: order.customerId,
        messageId: message.id,
        position: 0,
        deliveryStatus: DeliveryStatus.QUEUED,
        key: document.key,
        filename: document.filename,
        contentType: SUMMARY_CONTENT_TYPE,
        fileSize: document.byteLength,
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
      visibility: { hidden: false, assignedTo: input.assignedTo }
    })
    this.queueAfterCommit(tx, storeId, message.id)
  }

  // The fallback: the rendered text in one generic email (`ORDER_MESSAGE`). The email is queued first, under an id made from the
  // key, and the dispatch is claimed after it: a process that dies in between leaves an email that a retry would send again
  // (the id makes the second add one job while the first still exists), never a customer who was not told and nobody who knows.
  // A queue that cannot take it throws before anything is claimed.
  private async sendEmail(
    input: SendOrderMessageInput,
    order: LoadedOrder,
    locale: string,
    decision: Extract<Decision, { route: typeof OrderMessageRoutes.EMAIL }>
  ): Promise<OrderMessageOutcome> {
    const { storeId } = input
    try {
      await this.emailQueue.add(
        JobNames.SEND_EMAIL,
        {
          template: EmailTemplates.ORDER_MESSAGE,
          to: decision.email,
          locale: localeOf(locale),
          data: {
            storeName: order.store.name,
            orderNumber: order.orderNumber,
            text: decision.text
          },
          tags: { storeId, template: EmailTemplates.ORDER_MESSAGE }
        },
        // The job holds the address and the text of the message: once sent it has no reason to stay
        // and neither has a job that failed for good, which keeps the address and the text for a day for whoever looks at it
        {
          removeOnComplete: true,
          removeOnFail: { age: EMAIL_FAILED_JOB_KEEP_SECONDS },
          jobId: emailJobId(storeId, input.idempotencyKey)
        }
      )
    } catch (error) {
      // A queue that cannot take it now may take it a moment later: nothing is claimed, so the caller asks again (the listeners
      // retry, a person sees the error and presses again), instead of a message that is never sent because of a blip
      this.logger.error(
        { orderId: order.id, kind: input.kind, errorName: errorName(error) },
        'the email of an order message could not be queued'
      )
      throw error
    }
    const claimed = await this.prisma.transaction(tx =>
      this.claim(tx, input, OrderMessageRoutes.EMAIL, null, locale)
    )
    if (!claimed) return this.duplicateOf(input)
    this.logSent(input, order, OrderMessageRoutes.EMAIL)
    return {
      status: OrderMessageOutcomeStatus.SENT,
      route: OrderMessageRoutes.EMAIL,
      messageId: null
    }
  }

  private async recordNotSent(
    input: SendOrderMessageInput,
    order: LoadedOrder,
    reason: OrderMessageNotSentReason,
    locale: string | null
  ): Promise<OrderMessageOutcome> {
    const claimed = await this.prisma.transaction(async tx => {
      const made = await this.claim(tx, input, OrderMessageRoutes.NOT_SENT, reason, locale)
      if (made) this.announceNotSent(tx, input, order, reason)
      return made
    })
    if (!claimed) return this.duplicateOf(input)
    this.logNotSent(input, order, reason)
    return { status: OrderMessageOutcomeStatus.NOT_SENT, reason }
  }

  private announceNotSent(
    tx: PrismaTransaction,
    input: SendOrderMessageInput,
    order: LoadedOrder,
    reason: OrderMessageAlertReason
  ): void {
    if (SILENT_REASONS.has(reason)) return
    this.events.publish(tx, Events.ORDER_MESSAGE_NOT_SENT, {
      storeId: input.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      kind: input.kind,
      reason,
      // The person who pressed "send" has the answer of their request; the one whose action started a message that goes after the
      // commit (a creation, a status) has none, so the alert is for them too
      actor:
        input.trigger === OrderMessageTriggers.MANUAL && input.requestedBy !== null
          ? { type: 'user', id: input.requestedBy }
          : SYSTEM
    })
  }

  // The first writer of a key wins (the unique index of the store and the key): false when the key was already used
  private async claim(
    tx: PrismaTransaction,
    input: SendOrderMessageInput,
    route: OrderMessageRoute,
    reason: OrderMessageNotSentReason | null,
    locale: string | null,
    messageId: string | null = null
  ): Promise<boolean> {
    const { count } = await tx.orderMessageDispatch.createMany({
      data: [
        {
          storeId: input.storeId,
          orderId: input.orderId,
          kind: input.kind,
          trigger: input.trigger,
          route,
          reason,
          idempotencyKey: input.idempotencyKey,
          messageId,
          shipmentId: input.shipmentId ?? null,
          requestedBy: input.requestedBy,
          locale
        }
      ],
      skipDuplicates: true
    })
    return count === 1
  }

  // ---------------------------------------------------------------------------------------------------------------------
  // Reading

  // What an earlier send under this key did, as the answer to asking again
  private async storedOutcome(
    storeId: string,
    idempotencyKey: string
  ): Promise<Extract<
    OrderMessageOutcome,
    { status: typeof OrderMessageOutcomeStatus.DUPLICATE }
  > | null> {
    const found = await this.prisma.client.orderMessageDispatch.findFirst({
      where: { storeId, idempotencyKey },
      select: { route: true, reason: true, messageId: true }
    })
    if (found === null) return null
    return {
      status: OrderMessageOutcomeStatus.DUPLICATE,
      // The columns are strings (open sets, TDD_17 §2): what this service wrote is one of the sets, which the CHECKs keep
      route: found.route as OrderMessageRoute,
      reason: found.reason as OrderMessageNotSentReason | null,
      messageId: found.messageId
    }
  }

  // The writer that lost the race answers as the winner did
  private async duplicateOf(
    input: SendOrderMessageInput
  ): Promise<Extract<OrderMessageOutcome, { status: typeof OrderMessageOutcomeStatus.DUPLICATE }>> {
    const stored = await this.storedOutcome(input.storeId, input.idempotencyKey)
    // The winner's row is there once the key was taken; it is gone only if its order was deleted in between
    if (stored === null) throw resourceNotFound('order message')
    return stored
  }

  private async loadOrder(storeId: string, orderId: string): Promise<LoadedOrder> {
    const order = await this.prisma.client.order.findFirst({
      where: { id: orderId, storeId },
      select: ORDER_SELECT
    })
    if (order === null) {
      throw resourceNotFound('order')
    }
    return order
  }

  private async shipmentOf(
    storeId: string,
    orderId: string,
    shipmentId: string | undefined,
    kind: OrderMessageKindType
  ): Promise<{
    carrierName: string
    guideNumber: string | null
    trackingUrl: string | null
    failedAttempts: number
    maxDeliveryAttempts: number
    codAmountCents: number | null
  } | null> {
    // The way back is told with the guide of the way back; everything else with an outbound one. A guide the caller names must be of
    // that kind too: the number of the wrong guide would reach the customer as the right one
    const wanted =
      kind === OrderMessageKind.RETURN_APPROVED ? ShipmentKind.RETURN : ShipmentKind.OUTBOUND
    const live = {
      storeId,
      orderId,
      kind: wanted,
      status: { notIn: [...ShipmentInactiveStatuses] }
    }
    // Two live guides of the way back (two returns of one order): the message is about one of them and nothing here says which, so
    // it is not guessed; the agent names the guide
    if (
      shipmentId === undefined &&
      wanted === ShipmentKind.RETURN &&
      (await this.prisma.client.shipment.count({ where: live })) > 1
    ) {
      return null
    }
    const where =
      shipmentId === undefined ? live : { id: shipmentId, storeId, orderId, kind: wanted }
    const row = await this.prisma.client.shipment.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        guideNumber: true,
        trackingUrl: true,
        failedAttempts: true,
        codAmountCents: true,
        connection: { select: { displayName: true, maxDeliveryAttempts: true } }
      }
    })
    if (row === null) return null
    return {
      carrierName: row.connection.displayName,
      guideNumber: row.guideNumber,
      trackingUrl: row.trackingUrl,
      failedAttempts: row.failedAttempts,
      maxDeliveryAttempts: row.connection.maxDeliveryAttempts,
      codAmountCents: row.codAmountCents
    }
  }

  private logSent(
    input: SendOrderMessageInput,
    order: LoadedOrder,
    route: OrderMessageRoute
  ): void {
    this.audit.log({
      action: AuditAction.ORDER_MESSAGE_SENT,
      actor: input.requestedBy === null ? { system: true } : { userId: input.requestedBy },
      storeId: input.storeId,
      resourceType: OrderResourceTypes.ORDER,
      resourceId: order.id,
      metadata: { orderNumber: order.orderNumber, kind: input.kind, route, trigger: input.trigger }
    })
  }

  private logNotSent(
    input: SendOrderMessageInput,
    order: LoadedOrder,
    reason: OrderMessageAlertReason
  ): void {
    this.audit.log({
      action: AuditAction.ORDER_MESSAGE_NOT_SENT,
      actor: input.requestedBy === null ? { system: true } : { userId: input.requestedBy },
      storeId: input.storeId,
      resourceType: OrderResourceTypes.ORDER,
      resourceId: order.id,
      metadata: { orderNumber: order.orderNumber, kind: input.kind, reason, trigger: input.trigger }
    })
  }
}

// What the selects above read of an order, spelled out so that the rest of the service does not depend on the shape Prisma infers
interface LoadedOrder {
  id: string
  orderNumber: string
  conversationId: string | null
  customerId: string
  totalCents: number
  currency: string
  shippingAddress: unknown
  scheduledDeliveryDate: Date | null
  trackingNumber: string | null
  store: { name: string; defaultLocale: string }
  customer: {
    name: string | null
    email: string | null
    locale: string | null
    erasedAt: Date | null
  }
  items: {
    productName: string
    variantName: string | null
    quantity: number
    unitPriceCents: number
  }[]
}

function policyOf(plugin: {
  messagingWindow?: { hours: number; requiresTemplateWhenClosed: boolean } | null
}) {
  return plugin.messagingWindow ?? null
}

// The id of the email job of a send: a hash, so that it holds nothing of the key and no character a queue refuses
function emailJobId(storeId: string, idempotencyKey: string): string {
  return `order-message-${createHash('sha256').update(`${storeId}:${idempotencyKey}`).digest('hex')}`
}

function codeOf(error: unknown): string | undefined {
  return error instanceof PlatformException ? error.code : undefined
}
