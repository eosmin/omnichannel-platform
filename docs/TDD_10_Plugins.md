# TDD 10 — Plugin Architecture & Channels

> Part of the Omnichannel Commerce Platform TDD v1.1
> Covers: plugin SDK, registry, official channel plugins, third-party plugins, widgets

---

## 1. Core concept

**WhatsApp, Instagram, Messenger, the web widget and email are plugins.** They are built
against the same public SDK that third-party developers will use. The messaging core knows
nothing about any specific channel.

```
┌──────────────────────────────────────────────────────────┐
│                     Messaging Core                       │
│  Conversations · Messages · Customers · Billing          │
│  Knows nothing about WhatsApp or Instagram               │
└────────────────────────┬─────────────────────────────────┘
                         │ ChannelPlugin interface
   ┌──────────┬──────────┼──────────┬───────────┬──────────┐
   │          │          │          │           │          │
┌──▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼─────┐ ┌───▼───┐ ┌────▼──────┐
│WhatsApp│ │Instagram│ │Messenger│ │Web widget│ │ Email │ │Third-party│
│official│ │official │ │official │ │ official │ │official│ │(Telegram) │
└────────┘ └─────────┘ └─────────┘ └──────────┘ └───────┘ └───────────┘
```

**Why this matters:** if the core needed changes to add a channel, the plugin
system would be fiction. Building official channels on the public SDK proves
the SDK is sufficient.

**Two rules that make it work:**
1. A plugin is a **stateless singleton**. Everything per-store (credentials, the
   connection record) is passed **in** by the core as a `ChannelContext`. The plugin never
   touches Prisma, Redis, the event bus or the environment beyond what the SDK gives it.
2. Every inbound event names the **recipient** (`connectionId`). The core resolves the
   store from that, never from who is writing.

---

## 2. Plugin SDK

```typescript
// libs/plugins/sdk/src/channel-capability.ts
export const ChannelCapability = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  LOCATION: 'location',
  BUTTONS: 'buttons',
  LIST_PICKER: 'list_picker',
  TEMPLATES: 'templates',
  TYPING_INDICATOR: 'typing_indicator',
  READ_RECEIPTS: 'read_receipts',
  DELIVERY_RECEIPTS: 'delivery_receipts',
  REACTIONS: 'reactions',
  REPLY_TO: 'reply_to',
  MESSAGING_WINDOW: 'messaging_window',
  CUSTOMER_TYPING: 'customer_typing',
} as const

export type ChannelCapabilityType = typeof ChannelCapability[keyof typeof ChannelCapability]
```

```typescript
// libs/plugins/sdk/src/channel-plugin.interface.ts
export interface ChannelPlugin {
  // Identity
  readonly id: ChannelType                 // 'whatsapp' — also the Plugin.id and ChannelConnection.pluginId
  readonly name: string                    // 'WhatsApp Business'
  readonly version: string                 // '1.0.0'
  readonly author: string
  readonly type: 'channel'
  readonly capabilities: readonly ChannelCapabilityType[]

  // Declared messaging-window policy, applied by the CORE (§4) — the plugin has no database
  readonly messagingWindow: MessagingWindowPolicy | null

  // Connection lifecycle (credentials are supplied by the core, encrypted at rest by the core)
  connect(input: ConnectInput): Promise<ConnectResult>
  disconnect(ctx: ChannelContext): Promise<void>
  healthCheck(ctx: ChannelContext): Promise<ChannelHealth>

  // Outbound messaging — every call receives the connection context
  sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult>
  sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult>

  // Optional, gated by declared capabilities
  sendTemplate?(ctx: ChannelContext, params: SendTemplateParams): Promise<ChannelMessageResult>
  listTemplates?(ctx: ChannelContext): Promise<MessageTemplate[]>
  sendButtons?(ctx: ChannelContext, params: SendButtonsParams): Promise<ChannelMessageResult>
  sendLocation?(ctx: ChannelContext, params: SendLocationParams): Promise<ChannelMessageResult>
  sendTypingIndicator?(ctx: ChannelContext, params: TypingParams): Promise<void>
  markAsRead?(ctx: ChannelContext, params: MarkReadParams): Promise<void>

  // Inbound
  verifyWebhook?(query: Record<string, string>): string | null   // GET handshake (Meta hub.challenge); null = reject
  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean
  handleWebhook(payload: unknown): Promise<ChannelEvent[]>       // Pure: normalizes, never fetches
  fetchMedia?(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia>   // Provider media needs the connection token
}
```

**Supporting types:**

```typescript
// libs/plugins/sdk/src/types.ts
export const ChannelEventTypes = {
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_DELIVERED: 'message_delivered',
  MESSAGE_READ: 'message_read',
  MESSAGE_FAILED: 'message_failed',
  CUSTOMER_TYPING: 'customer_typing',
  CONNECTION_ERROR: 'connection_error',      // e.g. token revoked, reported by the provider
} as const
export type ChannelEventType = typeof ChannelEventTypes[keyof typeof ChannelEventTypes]

export interface ChannelEvent {
  type: ChannelEventType
  // The RECIPIENT of the event — WhatsApp phone_number_id, Facebook Page id, Instagram
  // business account id, widget site key, inbound mailbox. Resolves the store (§4).
  connectionId: string
  // The customer's handle on this channel — phone (E.164 without '+'), page-scoped id,
  // widget visitor id, email address.
  channelIdentity: string
  channelProfile?: { displayName?: string; avatarUrl?: string; locale?: string }
  message?: {
    externalId: string
    type: MessageType
    content: string | null
    media?: { ref: string; contentType: string; filename: string | null }   // Fetched later by the core (TDD_07 §6.5)
    replyToExternalId?: string
    metadata?: Record<string, unknown>
    timestamp: string                    // ISO 8601
  }
  status?: { externalId: string; error?: { code: string; message: string } }   // For delivery/read/failed events
  timestamp: string
}

export interface ChannelContext {
  storeId: string
  connectionId: string
  credentials: Record<string, unknown>   // Decrypted by the core just for this call; shape validated by the plugin's Zod schema
  metadata: Record<string, unknown>      // ChannelConnection.metadata
}

export interface ConnectInput {
  storeId: string
  credentials: Record<string, unknown>   // From the connect UI (§10); plugin validates with its schema
}

export interface ConnectResult {
  connectionId: string
  displayName: string                    // Shown in the UI: phone number, page name, site domain, mailbox
  credentials: Record<string, unknown>   // What to persist (may differ from input: exchanged long-lived token)
  metadata: Record<string, unknown>
}

export interface ChannelHealth {
  healthy: boolean
  checkedAt: string
  error?: string
}

export interface MessagingWindowPolicy {
  hours: number                          // 24 for WhatsApp/Instagram/Messenger
  requiresTemplateWhenClosed: boolean    // WhatsApp: true (approved templates); Meta DM: false (cannot send at all)
}

export interface ChannelMessageResult {
  externalId: string
  status: DeliveryStatus
  sentAt: string
  metadata?: Record<string, unknown>
}

export interface SendMessageParams {
  channelIdentity: string
  content: string
  replyToExternalId?: string
  idempotencyKey: string                 // Message.id — providers that support idempotency get it
}

export interface FetchedMedia { stream: NodeJS.ReadableStream; contentType: string; contentLength: number | null }
```

**Design rule:** the plugin returns normalized `ChannelEvent` objects.
It never writes to the database, never touches Prisma, never knows what a
`Conversation` is. Translation from `ChannelEvent` to domain entities happens
in the core (§4). The SDK exposes exactly three platform helpers to plugins:
`createPluginLogger(pluginId)` (Pino child), `PluginError` (maps to `ErrorCodes.CHANNEL_*`)
and `httpClient` (axios instance with timeouts) — nothing else from `libs/core`.

---

## 3. Plugin registry

```typescript
// libs/plugins/runtime/src/plugin-registry.ts
@Injectable()
export class PluginRegistry {
  private readonly plugins = new Map<ChannelType, ChannelPlugin>()

  constructor(@InjectPinoLogger(PluginRegistry.name) private readonly logger: PinoLogger) {}

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new PlatformException(ErrorCodes.PLUGIN_ALREADY_REGISTERED, `Plugin ${plugin.id} already registered`, 500)
    }
    this.validateContract(plugin)
    this.plugins.set(plugin.id, plugin)
    this.logger.info({ pluginId: plugin.id, version: plugin.version }, 'plugin registered')
  }

  get(pluginId: ChannelType): ChannelPlugin {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new PlatformException(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin ${pluginId} not found`, 404)
    }
    return plugin
  }

  list(): ChannelPlugin[] {
    return [...this.plugins.values()]
  }

  hasCapability(pluginId: ChannelType, capability: ChannelCapabilityType): boolean {
    return this.plugins.get(pluginId)?.capabilities.includes(capability) ?? false
  }

  // Fails fast at boot if a plugin declares a capability it cannot fulfil
  private validateContract(plugin: ChannelPlugin): void {
    const required: ReadonlyArray<[ChannelCapabilityType, keyof ChannelPlugin]> = [
      [ChannelCapability.TEMPLATES, 'sendTemplate'],
      [ChannelCapability.TEMPLATES, 'listTemplates'],
      [ChannelCapability.BUTTONS, 'sendButtons'],
      [ChannelCapability.LOCATION, 'sendLocation'],
      [ChannelCapability.TYPING_INDICATOR, 'sendTypingIndicator'],
      [ChannelCapability.READ_RECEIPTS, 'markAsRead'],
    ]

    for (const [capability, method] of required) {
      if (plugin.capabilities.includes(capability) && typeof plugin[method] !== 'function') {
        throw new PlatformException(
          ErrorCodes.PLUGIN_CONTRACT_VIOLATION,
          `Plugin ${plugin.id} declares ${capability} but does not implement ${String(method)}`, 500
        )
      }
    }
    if (plugin.capabilities.includes(ChannelCapability.MESSAGING_WINDOW) && !plugin.messagingWindow) {
      throw new PlatformException(ErrorCodes.PLUGIN_CONTRACT_VIOLATION, `Plugin ${plugin.id} declares messaging_window without a policy`, 500)
    }
  }
}
```

**Registration at boot** — plugins are Nest providers so they can receive the SDK helpers:

```typescript
// libs/plugins/runtime/src/plugins.module.ts
@Module({
  providers: [PluginRegistry, WhatsAppPlugin, InstagramPlugin, MessengerPlugin, WebWidgetPlugin, EmailChannelPlugin],
  exports: [PluginRegistry],
})
export class PluginsModule implements OnModuleInit {
  constructor(private readonly registry: PluginRegistry, private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    for (const cls of OFFICIAL_PLUGINS) this.registry.register(this.moduleRef.get(cls))
  }
}
```

Both `apps/api` and `apps/worker` import `PluginsModule` (the worker sends outbound
messages and fetches media).

---

## 4. Inbound message pipeline

This is the most important flow in the system. It is entirely channel-agnostic, and it is
split in two: the controller verifies and **enqueues** (providers need a fast 200), the
worker does the work.

```
Channel provider POSTs webhook
  ↓
POST /api/v1/webhooks/channels/:pluginId                       (apps/api)
  ├─ plugin.validateWebhookSignature(rawBody, headers)         ← 401 if invalid, counted in CHANNEL_WEBHOOK_REJECTED
  ├─ plugin.handleWebhook(body) → ChannelEvent[]               (pure normalization)
  ├─ inboundQueue.add(PROCESS_CHANNEL_EVENT, …) per event      (jobId = pluginId:externalId → provider retries dedupe)
  └─ 200 { received: true }                                    p99 < 300ms
  ↓
InboundProcessor (apps/worker, queue INBOUND)
  For each event:
  ├─ resolve ChannelConnection by (pluginId, event.connectionId)  → storeId   (cached)
  ├─ find or create Customer via CustomerIdentity (storeId, channelType, channelIdentity)
  ├─ find open conversation / reopen within window / wake snoozed / create
  ├─ create Message (unique on conversationId + channelMessageId — duplicates are no-ops)
  ├─ enqueue FETCH_INBOUND_MEDIA when the message carries media
  ├─ record BillableConversation (24h window, idempotent) — quota is checked here
  ├─ apply routing rules (assignment) on a NEW conversation
  ├─ emit CONVERSATION_CREATED (first message only) and MESSAGE_RECEIVED
  └─ if the conversation handler is AI → aiQueue.add(PROCESS_AUTONOMOUS_CHATBOT_TURN)
  ↓
Realtime broadcast + notifications + AI classification (all via event listeners on the API)
```

```typescript
// apps/api/src/modules/channels/channel-webhook.controller.ts
@Controller()
export class ChannelWebhookController {
  constructor(
    private readonly registry: PluginRegistry,
    @InjectQueue(QueueNames.INBOUND) private readonly inboundQueue: Queue<ProcessChannelEventJob>,
    @InjectMetric(MetricNames.CHANNEL_WEBHOOK_RECEIVED) private readonly received: Counter,
    @InjectMetric(MetricNames.CHANNEL_WEBHOOK_REJECTED) private readonly rejected: Counter,
    @InjectPinoLogger(ChannelWebhookController.name) private readonly logger: PinoLogger,
  ) {}

  // Meta requires a GET verification handshake; other providers may not
  @Get(ApiRoutes.webhooks.channel(':pluginId'))
  verifyWebhook(
    @Param('pluginId', new ZodValidationPipe(channelTypeSchema)) pluginId: ChannelType,
    @Query() query: Record<string, string>,
  ): string {
    const challenge = this.registry.get(pluginId).verifyWebhook?.(query) ?? null
    if (challenge === null) {
      throw new PlatformException(ErrorCodes.AUTH_UNAUTHORIZED, 'Invalid verify token', 403)
    }
    return challenge
  }

  @Post(ApiRoutes.webhooks.channel(':pluginId'))
  @HttpCode(200)
  async handleWebhook(
    @Param('pluginId', new ZodValidationPipe(channelTypeSchema)) pluginId: ChannelType,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ): Promise<{ received: true }> {
    const plugin = this.registry.get(pluginId)
    const rawBody = req.rawBody?.toString() ?? ''

    if (!plugin.validateWebhookSignature(rawBody, headers)) {
      this.rejected.inc({ channel_type: pluginId })
      this.logger.warn({ pluginId }, 'invalid webhook signature')
      throw new PlatformException(ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID, 'Invalid signature', 401)
    }

    this.received.inc({ channel_type: pluginId })

    const events = await plugin.handleWebhook(req.body)
    const receivedAt = new Date().toISOString()
    await this.inboundQueue.addBulk(events.map(event => ({
      name: JobNames.PROCESS_CHANNEL_EVENT,
      data: { pluginId, event, receivedAt },
      opts: { jobId: inboundJobId(pluginId, event) },     // pluginId:type:externalId — provider retries collapse
    })))

    return { received: true }
  }
}
```

```typescript
// apps/worker/src/processors/inbound.processor.ts
@Processor(QueueNames.INBOUND, { concurrency: 20 })
export class InboundProcessor extends WorkerHost {
  async process(job: Job<ProcessChannelEventJob>): Promise<void> {
    const { pluginId, event } = job.data
    switch (event.type) {
      case ChannelEventTypes.MESSAGE_RECEIVED:
        return this.inbound.handleMessageReceived(pluginId, event)
      case ChannelEventTypes.MESSAGE_DELIVERED:
      case ChannelEventTypes.MESSAGE_READ:
      case ChannelEventTypes.MESSAGE_FAILED:
        return this.inbound.updateDeliveryStatus(pluginId, event)
      case ChannelEventTypes.CUSTOMER_TYPING:
        return this.inbound.broadcastCustomerTyping(pluginId, event)
      case ChannelEventTypes.CONNECTION_ERROR:
        return this.channels.markConnectionError(pluginId, event.connectionId, event)
    }
  }
}
```

```typescript
// libs/core/messaging/inbound-message.service.ts  (used by the worker)
@Injectable()
export class InboundMessageService {
  async handleMessageReceived(pluginId: ChannelType, event: ChannelEvent): Promise<void> {
    if (!event.message) return

    // 1. Resolve which store owns the RECIPIENT of this event
    const connection = await this.channels.resolveConnection(pluginId, event.connectionId)   // cached: CacheKeys.channel.connection
    if (!connection || connection.status === ChannelConnectionStatus.DISCONNECTED) {
      this.logger.warn({ pluginId, connectionId: event.connectionId }, 'inbound event for unknown connection')
      return
    }
    const storeId = connection.storeId

    // 2. Find or create the customer through their identity on this store
    const { customer, identity } = await this.customers.findOrCreateByIdentity({
      storeId,
      channelType: pluginId,
      channelIdentity: event.channelIdentity,
      profile: event.channelProfile,
    })

    // 3. Find the conversation: open → same; resolved within reopen window → reopen;
    //    snoozed → wake; otherwise create. Returns whether it was created.
    const { conversation, created } = await this.conversations.findOrReopenOrCreate({
      storeId,
      customerId: customer.id,
      customerIdentityId: identity.id,
      channelConnectionId: connection.id,
      channelType: pluginId,
    })

    // 4. Persist the message (idempotent on channelMessageId — provider retries are no-ops)
    const message = await this.messages.createInbound({
      storeId,
      conversationId: conversation.id,
      type: event.message.type,
      content: event.message.content,
      channelMessageId: event.message.externalId,
      replyToExternalId: event.message.replyToExternalId,
      metadata: event.message.metadata,
      createdAt: event.message.timestamp,
    })
    if (!message.created) return   // Duplicate delivery

    // 5. Media is fetched asynchronously — provider URLs need the connection token and expire
    if (event.message.media) {
      await this.heavyQueue.add(JobNames.FETCH_INBOUND_MEDIA, {
        messageId: message.id, storeId, pluginId, connectionId: event.connectionId,
        mediaRef: event.message.media.ref, contentType: event.message.media.contentType, filename: event.message.media.filename,
      })
    }

    // 6. Billing window (idempotent per 24h) + quota. On the Free tier past its limit the
    //    message is STILL stored (never lose customer data); the conversation is created
    //    with status OPEN but the store sees the "quota reached" state (TDD_11 §3).
    await this.usageMetering.recordBillableConversation({
      organizationId: connection.organizationId, storeId, conversationId: conversation.id, receivedAt: message.createdAt,
    })

    // 7. Routing on new conversations only
    if (created) await this.routing.apply(conversation)

    // 8. Emit — realtime, notifications, AI classification and plugin webhooks all listen
    if (created) {
      this.events.emit(Events.CONVERSATION_CREATED, {
        storeId, conversationId: conversation.id, customerId: customer.id, channelType: pluginId,
        firstMessageId: message.id, firstMessageContent: message.content,
      } satisfies ConversationCreatedPayload)
    }
    this.events.emit(Events.MESSAGE_RECEIVED, {
      storeId, conversationId: conversation.id, messageId: message.id, customerId: customer.id,
      channelType: pluginId, authorType: AuthorType.CUSTOMER,
      contentPreview: preview(message.content), receivedAt: message.createdAt.toISOString(),
    } satisfies MessageReceivedPayload)

    // 9. Autonomous handling (TDD_12 §13) — queued, never inline
    if (conversation.handler === ConversationHandler.AI) {
      await this.aiQueue.add(JobNames.PROCESS_AUTONOMOUS_CHATBOT_TURN,
        { conversationId: conversation.id, storeId, messageId: message.id },
        { jobId: conversation.id, deduplication: { id: conversation.id } })
    }
  }
}
```

**Idempotency:** `Message @@unique([conversationId, channelMessageId])` (`TDD_01` §4) plus
the BullMQ `jobId` on enqueue. Providers retry webhooks; duplicates are silently ignored.

**Messaging windows** are computed by the core, not the plugin:
`MessagingWindowService.get(conversationId)` reads `CustomerIdentity.lastInboundAt` (updated
in step 4) and `plugin.messagingWindow`; outbound sends call it before `plugin.sendMessage`
and throw `CHANNEL_WINDOW_EXPIRED` (with `requiresTemplate`) when closed.

**Routing rules** (`RoutingRule`, `TDD_01` §4): `RoutingService.apply` evaluates enabled
rules by priority; the first whose `conditions` match (channel, detected intent, tags,
keywords in the first message, outside business hours) executes its `action`
(assign to a user, round-robin over a user list, leave unassigned). No match → unassigned
queue. `PlanFeatures.ROUTING` gates rule *creation*; stores without it simply have no rules.

---

## 5. Official channel plugins

### 5.1 WhatsApp

```typescript
// libs/channels/whatsapp/src/whatsapp.plugin.ts
@Injectable()
export class WhatsAppPlugin implements ChannelPlugin {
  readonly id = ChannelType.WHATSAPP
  readonly name = 'WhatsApp Business'
  readonly version = '1.0.0'
  readonly author = 'Platform Team'
  readonly type = 'channel' as const
  readonly messagingWindow: MessagingWindowPolicy = { hours: 24, requiresTemplateWhenClosed: true }

  readonly capabilities = [
    ChannelCapability.TEXT, ChannelCapability.IMAGE, ChannelCapability.VIDEO, ChannelCapability.AUDIO,
    ChannelCapability.DOCUMENT, ChannelCapability.LOCATION, ChannelCapability.BUTTONS,
    ChannelCapability.LIST_PICKER, ChannelCapability.TEMPLATES, ChannelCapability.READ_RECEIPTS,
    ChannelCapability.DELIVERY_RECEIPTS, ChannelCapability.REPLY_TO, ChannelCapability.MESSAGING_WINDOW,
  ] as const

  constructor(private readonly meta: MetaGraphClient, private readonly config: MetaAppConfig) {}   // libs/channels/meta

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const creds = whatsAppCredentialsSchema.parse(input.credentials)   // { phoneNumberId, businessAccountId, accessToken }
    const profile = await this.meta.whatsapp.getPhoneNumber(creds)
    return {
      connectionId: creds.phoneNumberId,
      displayName: profile.displayPhoneNumber,
      credentials: creds,
      metadata: { businessAccountId: creds.businessAccountId, verifiedName: profile.verifiedName },
    }
  }

  async sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    const creds = whatsAppCredentialsSchema.parse(ctx.credentials)
    const response = await this.meta.whatsapp.sendText(creds, {
      to: params.channelIdentity,
      text: params.content,
      replyToMessageId: params.replyToExternalId,
    })
    return { externalId: response.messages[0].id, status: DeliveryStatus.SENT, sentAt: new Date().toISOString() }
  }

  async sendTemplate(ctx: ChannelContext, params: SendTemplateParams): Promise<ChannelMessageResult> {
    const creds = whatsAppCredentialsSchema.parse(ctx.credentials)
    const response = await this.meta.whatsapp.sendTemplate(creds, {
      to: params.channelIdentity, templateName: params.templateName, languageCode: params.languageCode, components: params.components,
    })
    return { externalId: response.messages[0].id, status: DeliveryStatus.SENT, sentAt: new Date().toISOString() }
  }

  async listTemplates(ctx: ChannelContext): Promise<MessageTemplate[]> {
    const creds = whatsAppCredentialsSchema.parse(ctx.credentials)
    return this.meta.whatsapp.listApprovedTemplates(creds)
  }

  verifyWebhook(query: Record<string, string>): string | null {
    return this.meta.verifyHubChallenge(query)          // hub.mode / hub.verify_token / hub.challenge, shared Meta app
  }

  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    return this.meta.validateSignature(rawBody, headers['x-hub-signature-256'])   // constant-time, length-safe (libs/channels/meta)
  }

  async handleWebhook(payload: unknown): Promise<ChannelEvent[]> {
    const parsed = whatsAppWebhookSchema.safeParse(payload)    // Zod: provider payloads are untrusted
    if (!parsed.success) return []
    const events: ChannelEvent[] = []

    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const connectionId = change.value.metadata.phone_number_id       // The RECIPIENT — resolves the store (§4)
        const profiles = new Map(change.value.contacts?.map(c => [c.wa_id, c.profile.name]) ?? [])

        for (const msg of change.value.messages ?? []) {
          events.push({
            type: ChannelEventTypes.MESSAGE_RECEIVED,
            connectionId,
            channelIdentity: msg.from,
            channelProfile: { displayName: profiles.get(msg.from) },
            message: {
              externalId: msg.id,
              type: mapWhatsAppMessageType(msg.type),
              content: extractContent(msg),
              media: extractMediaRef(msg),                                  // { ref: media.id, contentType, filename }
              replyToExternalId: msg.context?.id,
              timestamp: new Date(Number(msg.timestamp) * 1000).toISOString(),
            },
            timestamp: new Date().toISOString(),
          })
        }

        for (const status of change.value.statuses ?? []) {
          events.push({
            type: mapWhatsAppStatus(status.status),                          // sent|delivered|read|failed → ChannelEventTypes
            connectionId,
            channelIdentity: status.recipient_id,
            status: { externalId: status.id, error: status.errors?.[0] && { code: String(status.errors[0].code), message: status.errors[0].title } },
            timestamp: new Date(Number(status.timestamp) * 1000).toISOString(),
          })
        }
      }
    }
    return events
  }

  async fetchMedia(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia> {
    const creds = whatsAppCredentialsSchema.parse(ctx.credentials)
    return this.meta.whatsapp.downloadMedia(creds, mediaRef)     // GET /{media-id} → url → stream with the token
  }

  async healthCheck(ctx: ChannelContext): Promise<ChannelHealth> { /* GET phone number → healthy */ }
  async disconnect(ctx: ChannelContext): Promise<void> { /* unsubscribe app from WABA */ }
  async sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult> { /* upload → send */ }
}
```

`libs/channels/meta` holds the shared Graph API client (`META_GRAPH_API_VERSION`), the
webhook handshake (`META_WEBHOOK_VERIFY_TOKEN`) and the HMAC validation with
`META_APP_SECRET`; all three Meta plugins share one Meta app.

### 5.2 Instagram and Messenger

Both use the Meta Graph API with a shared base class.

```typescript
// libs/channels/meta/src/meta-channel.plugin.ts
export abstract class MetaChannelPlugin implements ChannelPlugin {
  readonly type = 'channel' as const
  readonly author = 'Platform Team'
  readonly version = '1.0.0'
  // Meta DM policy: reply within 24h of the last customer message; no templates outside it.
  readonly messagingWindow: MessagingWindowPolicy = { hours: 24, requiresTemplateWhenClosed: false }

  constructor(protected readonly meta: MetaGraphClient) {}

  verifyWebhook(query: Record<string, string>): string | null { return this.meta.verifyHubChallenge(query) }
  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    return this.meta.validateSignature(rawBody, headers['x-hub-signature-256'])
  }

  async handleWebhook(payload: unknown): Promise<ChannelEvent[]> {
    const parsed = metaMessagingWebhookSchema.safeParse(payload)
    if (!parsed.success) return []
    return parsed.data.entry.flatMap(entry =>
      entry.messaging.flatMap(m => this.mapMessagingEvent(entry.id, m) ?? [])    // entry.id = Page id / IG account id = connectionId
    )
  }

  protected abstract mapMessagingEvent(connectionId: string, messaging: MetaMessagingEvent): ChannelEvent | null
}

@Injectable()
export class InstagramPlugin extends MetaChannelPlugin {
  readonly id = ChannelType.INSTAGRAM
  readonly name = 'Instagram Direct'
  readonly capabilities = [
    ChannelCapability.TEXT, ChannelCapability.IMAGE, ChannelCapability.VIDEO,
    ChannelCapability.REACTIONS, ChannelCapability.REPLY_TO, ChannelCapability.MESSAGING_WINDOW,
  ] as const
  // connect(): Instagram business account id + page-scoped access token
}

@Injectable()
export class MessengerPlugin extends MetaChannelPlugin {
  readonly id = ChannelType.MESSENGER
  readonly name = 'Facebook Messenger'
  readonly capabilities = [
    ChannelCapability.TEXT, ChannelCapability.IMAGE, ChannelCapability.VIDEO, ChannelCapability.DOCUMENT,
    ChannelCapability.BUTTONS, ChannelCapability.TYPING_INDICATOR, ChannelCapability.READ_RECEIPTS,
    ChannelCapability.MESSAGING_WINDOW,
  ] as const
  // connect(): Page id + page access token
}
```

The exact window rules (24h, human-agent tag extensions) are Meta policy and must be
re-checked against Meta's current platform policy with Context7 when the plugin is
implemented; the `messagingWindow` policy object is where the number lives.

**Identity note:** Instagram and Messenger use page-scoped IDs, not usernames.
The same person messaging two different stores produces two different IDs, and the same
phone number messaging two stores on WhatsApp produces two `CustomerIdentity` rows —
customers are always store-scoped (`TDD_01` §4).

### 5.3 Capability-driven UI

The interface adapts to what the channel supports. No hardcoded channel checks
in components.

```tsx
function Composer({ conversation }: Props) {
  const { capabilities } = useChannelCapabilities(conversation.channelType)   // GET /channels/:pluginId/capabilities, cached

  return (
    <div>
      <TextInput />
      {capabilities.includes(ChannelCapability.IMAGE) && <AttachImageButton />}
      {capabilities.includes(ChannelCapability.DOCUMENT) && <AttachFileButton />}
      {capabilities.includes(ChannelCapability.BUTTONS) && <AddButtonsAction />}
      {capabilities.includes(ChannelCapability.TEMPLATES) && <SendTemplateButton />}
      {capabilities.includes(ChannelCapability.MESSAGING_WINDOW) && (
        <MessagingWindowIndicator conversationId={conversation.id} />
      )}
    </div>
  )
}
```

### 5.4 Web widget

The channel every tier gets (`TDD_11` §1). A store embeds a script on its own site; visitors
chat from a floating panel; messages land in the inbox like any other channel.

**Connection.** `connect({ siteOrigins: string[] })` generates a **site key** (`pk_widget_…`,
public, embedded in the snippet) — that key is the `connectionId`. `metadata.allowedOrigins`
holds the origins allowed to load the widget and call the widget API (CORS, `TDD_05` §6).

**Embed snippet** (shown in Settings → Channels and onboarding):
```html
<script async src="https://widget.platform.com/v1/widget.js" data-site-key="pk_widget_…"></script>
```

**Visitor identity.** `widget.js` keeps a `visitorId` (UUID) in `localStorage` on the
merchant's site; that is the `channelIdentity`. A pre-chat form (optional per store) collects
name/email/phone into `channelProfile`; an email match links the visitor to an existing
customer through the normal identity-linking rules.

**Transport.** The widget is a client of two public endpoints and one socket namespace,
all authenticated by the site key + visitor id and origin-checked:

| Surface | Purpose |
|---|---|
| `POST /api/v1/widget/bootstrap` `{ siteKey, visitorId }` | Returns store branding, business hours state, a short-lived visitor token, conversation history |
| `POST /api/v1/widget/messages` `{ visitorToken, content, mediaId? }` | Inbound message → **the plugin's `handleWebhook`** path: the controller wraps it as a `ChannelEvent` and enqueues `PROCESS_CHANNEL_EVENT`, exactly like a provider webhook |
| `POST /api/v1/widget/upload-url` | Presigned upload, `purpose: MESSAGE`, same limits (`TDD_07` §6) |
| `/widget` Socket.io namespace (`RoomNames.widgetVisitor`) | Outbound messages and agent typing pushed to the visitor |

Outbound: `WebWidgetPlugin.sendMessage` emits `RealtimeEvents.MESSAGE_SENT` on the visitor's
room and stores the message; if the visitor is offline the message waits in history and,
when the visitor left an email, an `EmailTemplates.EMAIL_CHANNEL_REPLY` copy is sent.

**Capabilities:** `TEXT`, `IMAGE`, `DOCUMENT`, `TYPING_INDICATOR`, `CUSTOMER_TYPING`,
`READ_RECEIPTS`. No messaging window.

**Widget UI** (`apps/widget`, vanilla TS, no framework, < 40 KB gzipped): launcher button,
panel with store name and avatar, message list, composer with attachment, "we're away"
banner from business hours, i18n from `Store.defaultLocale` (`es`/`en`), no inline
styles/scripts (works under strict merchant CSPs). Every autonomous reply carries the
"automated response" label (`TDD_12` §13.2).

### 5.5 Email

Email-to-conversation bridge on Resend Receiving.

**Connection.** `connect({ mailbox })` provisions `{mailbox}@{EMAIL_INBOUND_DOMAIN}` (e.g.
`ventas-acme@inbound.platform.com`); that address is the `connectionId`. Custom domains
(`soporte@acme.com` with MX to Resend) are a Growth+ setting on the same connection.

**Inbound.** Resend calls `ApiRoutes.webhooks.resend` with `email.received` (`TDD_07` §5.4).
`EmailChannelPlugin.handleWebhook` turns it into a `ChannelEvent`:
`connectionId` = the `to` address that matched a connection, `channelIdentity` = sender
address, `message.externalId` = the RFC `Message-ID`, `content` = the text body with quoted
history stripped (`email-reply-parser`), attachments as `media` refs fetched by
`fetchMedia` through the Resend API. Threading uses `In-Reply-To`/`References` so a reply
to an older thread lands in the right conversation; otherwise the normal reopen window
applies.

**Outbound.** `sendMessage` renders `EmailTemplates.EMAIL_CHANNEL_REPLY` (store branding,
the agent's message, quoted context) and sends from the connection address with
`In-Reply-To` set to the last inbound `Message-ID`; `Reply-To` is the connection address.

**Capabilities:** `TEXT`, `IMAGE`, `DOCUMENT`, `REPLY_TO`. No messaging window, no typing.

---

## 6. Third-party plugins (SDK in scope; marketplace and moderation are MATURE)

### 6.1 Manifest

```json
{
  "id": "telegram-connector",
  "version": "1.0.0",
  "name": "Telegram Integration",
  "description": "Connect Telegram to your unified inbox",
  "author": { "name": "Acme Inc", "email": "support@acme.com", "url": "https://acme.com" },
  "type": "channel",
  "icon": "https://cdn.acme.com/telegram.svg",
  "pricing": { "model": "free" },
  "scopes": [
    "conversations:read",
    "conversations:write",
    "messages:read",
    "messages:write",
    "customers:read",
    "webhooks:write"
  ],
  "capabilities": ["text", "image", "buttons"],
  "webhooks": {
    "endpoint": "https://acme.com/webhooks/platform",
    "events": ["conversation.created", "message.received"],
    "signatureHeader": "X-Platform-Signature"
  },
  "ui": {
    "settings": "https://acme.com/plugin/settings",
    "widget": "https://acme.com/plugin/widget"
  },
  "widgets": [
    {
      "id": "telegram-info",
      "name": "Telegram Info",
      "defaultWidth": 300,
      "defaultHeight": 400,
      "refreshInterval": 5000
    }
  ],
  "limits": { "maxRequestsPerMinute": 60, "maxWebhooksPerDay": 10000 },
  "legal": {
    "privacyPolicy": "https://acme.com/privacy",
    "termsOfService": "https://acme.com/terms"
  }
}
```

`capabilities` values are `ChannelCapability` values; `webhooks.events` are `Events`
values; the whole document is validated by `pluginManifestSchema` (Zod) on submission.

### 6.2 Scopes

```typescript
export const PluginScopes = {
  CONVERSATIONS_READ: 'conversations:read',
  CONVERSATIONS_WRITE: 'conversations:write',
  MESSAGES_READ: 'messages:read',
  MESSAGES_WRITE: 'messages:write',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  ORDERS_READ: 'orders:read',
  ORDERS_WRITE: 'orders:write',
  PRODUCTS_READ: 'products:read',
  WEBHOOKS_WRITE: 'webhooks:write',
  ANALYTICS_READ: 'analytics:read',
} as const

export type PluginScope = typeof PluginScopes[keyof typeof PluginScopes]

// Each scope grants a fixed subset of the human Permissions — a plugin can never exceed
// what a human could do.
export const PluginScopePermissions: Record<PluginScope, readonly Permission[]> = {
  [PluginScopes.CONVERSATIONS_READ]:  [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_VIEW_ALL],
  [PluginScopes.CONVERSATIONS_WRITE]: [Permissions.CONVERSATIONS_CREATE, Permissions.CONVERSATIONS_ASSIGN, Permissions.CONVERSATIONS_RESOLVE, Permissions.CONVERSATIONS_SNOOZE],
  [PluginScopes.MESSAGES_READ]:       [Permissions.MESSAGES_VIEW],
  [PluginScopes.MESSAGES_WRITE]:      [Permissions.MESSAGES_SEND, Permissions.MESSAGES_INTERNAL_NOTE],
  [PluginScopes.CUSTOMERS_READ]:      [Permissions.CUSTOMERS_VIEW],
  [PluginScopes.CUSTOMERS_WRITE]:     [Permissions.CUSTOMERS_CREATE, Permissions.CUSTOMERS_EDIT],
  [PluginScopes.ORDERS_READ]:         [Permissions.ORDERS_VIEW],
  [PluginScopes.ORDERS_WRITE]:        [Permissions.ORDERS_CREATE, Permissions.ORDERS_CHANGE_STATUS],
  [PluginScopes.PRODUCTS_READ]:       [Permissions.PRODUCTS_VIEW],
  [PluginScopes.WEBHOOKS_WRITE]:      [],
  [PluginScopes.ANALYTICS_READ]:      [Permissions.ANALYTICS_VIEW],
}
```

### 6.3 Installation flow

```
Store admin clicks Install (PlanFeatures.THIRD_PARTY_PLUGINS, QuotaGuard(CHANNELS) for channel plugins)
  ↓
Consent screen shows:
  • Exactly what the plugin can access, in plain language
  • Rate limits
  • Links to privacy policy and terms
  • Who published it
  ↓
[Authorize]
  ↓
Backend:
  1. Validate manifest schema (again — the catalog row may be stale)
  2. Verify the webhook endpoint responds to a challenge (assertPublicHttpsUrl, TDD_07 §2)
  3. Create PluginInstallation { status: PENDING_SETUP, scopes granted }
  4. Generate a scoped API key: pk_{12 random}.{32 random} — store keyPrefix + sha256 hash ONLY;
     the full key is shown once to the plugin setup handshake, never again
  5. Audit log the installation (PLUGIN_INSTALLED)
  6. Redirect to the plugin's setup URL with a one-time code (5 min, Redis)
  ↓
Plugin exchanges the code for the API key and calls back
  ↓
Status: ACTIVE (PLUGIN_ENABLED)
```

### 6.4 Plugin API authentication

Plugin requests do not carry a user; they carry the installation. `PluginApiKeyGuard`
replaces `AuthGuard` + `TenantGuard` on plugin routes (`/api/v1/plugin-api/*`) and builds
the same `request.store` / `request.permissions` context so downstream services and
`PermissionGuard` behave identically.

```typescript
@Injectable()
export class PluginApiKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const apiKey = extractBearerToken(request)
    if (!apiKey) throw new PlatformException(ErrorCodes.PLUGIN_API_KEY_INVALID, 'Missing API key', 401)

    const installation = await this.prisma.client.pluginInstallation.findUnique({
      where: { apiKeyHash: sha256(apiKey) },
      include: { store: { include: { organization: { include: { subscription: true } } } } },
    })

    if (!installation || installation.status !== PluginInstallationStatus.ACTIVE) {
      throw new PlatformException(ErrorCodes.PLUGIN_API_KEY_INVALID, 'Invalid API key', 401)
    }

    // Scope check against the decorator on the handler
    const required = this.reflector.get<PluginScope[] | undefined>(PLUGIN_SCOPES_KEY, context.getHandler()) ?? []
    const granted = installation.scopes as PluginScope[]
    if (required.some(s => !granted.includes(s))) {
      throw new PlatformException(ErrorCodes.PLUGIN_SCOPE_DENIED, 'Missing required scope', 403, { required, granted })
    }

    // Per-installation rate limiting (Redis), limit from the manifest
    await this.rateLimiter.consume(CacheKeys.rateLimit(`plugin:${installation.id}`, 'api'), installation.rateLimitPerMinute)

    // Force tenant scope — a plugin can only ever see its own store
    request.store = installation.store
    request.organization = installation.store.organization
    request.permissions = granted.flatMap(s => PluginScopePermissions[s])
    request.pluginInstallation = installation
    request.accessLevel = installation.store.organization.accessLevel as AccessLevel
    return true
  }
}
```

**The plugin is bound to exactly one store.** It cannot enumerate other stores,
cannot change `storeId`, and every service it reaches is scoped by the same
`request.store` that `TenantGuard` would have set for a human.

### 6.5 Outbound webhooks to plugins

```typescript
@OnEvent(Events.MESSAGE_RECEIVED)
async notifySubscribedPlugins(payload: MessageReceivedPayload): Promise<void> {
  const installations = await this.prisma.client.pluginInstallation.findMany({
    where: {
      storeId: payload.storeId,
      status: PluginInstallationStatus.ACTIVE,
      scopes: { has: PluginScopes.MESSAGES_READ },
      plugin: { status: PluginStatus.APPROVED },        // Suspended plugins get nothing (TDD_15 §7)
    },
    select: { id: true, scopes: true },
  })

  for (const installation of installations) {
    await this.webhooksQueue.add(JobNames.TRIGGER_PLUGIN_WEBHOOK, {
      pluginInstallationId: installation.id,
      storeId: payload.storeId,
      event: Events.MESSAGE_RECEIVED,
      payload: redactForScopes(payload, installation.scopes as PluginScope[]),
    } satisfies TriggerPluginWebhookJob)
  }
}
```

Payloads are redacted to the granted scopes. A plugin with only
`messages:read` never receives customer contact details.

### 6.6 Revocation

```
Settings → Plugins → [plugin] → Revoke access
  ↓
Confirmation requires typing REVOKE
  ↓
Backend:
  1. Set installation status to REVOKED, revokedAt
  2. The API key hash is now unusable (status check in the guard)
  3. Delete webhook subscriptions
  4. Send a final plugin.revoked webhook
  5. Audit log (PLUGIN_REVOKED)
  6. Notify store admins
```

---

## 7. Plugin widgets

Plugins can render UI inside the agent sidebar, sandboxed in an iframe.

```tsx
<div className="plugin-widget rounded-lg border">
  <div className="flex items-center gap-2 border-b px-3 py-2">
    <img src={plugin.icon} alt="" className="h-4 w-4" />
    <span className="text-sm font-medium">{plugin.name}</span>
    <Button variant="ghost" size="icon" onClick={openWidgetSettings} aria-label={t('plugins.widgetSettings')}>
      <Settings className="h-3 w-3" />
    </Button>
  </div>

  <iframe
    ref={frameRef}
    src={widgetUrl}                                   // plugin.ui.widget + ?conversationId=…  (no tokens in the URL)
    sandbox="allow-scripts allow-forms allow-same-origin"
    referrerPolicy="no-referrer"
    className="h-[400px] w-full border-0"
  />
</div>
```

**Security model:**
- `allow-same-origin` is required so the iframe keeps its **own** origin
  (`plugin.ui.widget`'s host); without it the frame's origin is opaque (`"null"`) and the
  parent could never verify who is talking. The iframe still cannot read the parent DOM,
  cookies or storage — it is a different origin.
- The API key is **never** passed to the iframe. No token travels in the URL either.
- The parent opens a `MessageChannel` after load and posts one port to the iframe with
  `targetOrigin = widgetOrigin`; all plugin API calls go through that port, are
  scope-checked and re-validated server-side (`/api/v1/plugin-api/*` with a short-lived
  widget session token minted per conversation open, 5 min, sent **over the port**).
- `frame-src` in the web CSP is extended per store with the origins of its installed
  plugins' `ui.widget` URLs (`TDD_05` §6).

```typescript
// apps/web/lib/plugin-widget-bridge.ts (parent side)
const channel = new MessageChannel()
frame.contentWindow?.postMessage({ type: PluginBridgeMessages.INIT }, widgetOrigin, [channel.port2])

channel.port1.onmessage = async (event: MessageEvent<PluginBridgeRequest>) => {
  const request = pluginBridgeRequestSchema.safeParse(event.data)   // Zod: the iframe is untrusted
  if (!request.success) return
  const response = await proxyPluginRequest(installationId, conversationId, request.data)   // Scope check + server call
  channel.port1.postMessage(response)
}
```

The iframe side only ever talks to the port it received; it never uses
`window.parent.postMessage` for data.

---

## 8. Plugin marketplace (MATURE)

```
Settings → Plugins → Browse marketplace

Categories
├─ Channels (4)
├─ Shipping & logistics (5)
├─ Payments (4)
├─ Marketing (8)
└─ Analytics (6)

┌────────────────────────────────────────┐
│ [icon] Telegram Integration            │
│ by Acme Inc · 4.8 (245 reviews)        │
│                                        │
│ Connect Telegram to your inbox         │
│                                        │
│ Free · 1,234 installs      [Install]   │
└────────────────────────────────────────┘
```

### 8.1 Pricing models

`manifest.pricing.model` (§6.1) is one of three values — a plugin declares
exactly one, never a mix:

```typescript
export const PluginPricingModels = {
  FREE: 'free',              // No charge. Gated only by maxChannels count.
  PAID: 'paid',               // Developer sets a price. We take a revenue share.
  PLAN_GATED: 'plan_gated',   // We (not the developer) restrict install by tier.
} as const

// Manifest shape per model
{ "pricing": { "model": "free" } }

{ "pricing": {
    "model": "paid",
    "priceCents": 900,                    // Set by the developer, monthly
    "billedVia": "platform_stripe_connect",
    "platformRevenueSharePercent": 20     // Same rate across all paid plugins
} }

{ "pricing": {
    "model": "plan_gated",
    "allowedTiers": ["growth", "scale", "enterprise"]   // We control this, not them
} }
```

- **`free`** is what most third-party channel connectors (Telegram, X, Line)
  ship as — the developer wants distribution, not revenue. Still counts
  against the store's `maxChannels` limit.
- **`paid`** plugins are billed through the platform's Stripe Connect account
  so the store never shares payment details with the third-party developer.
  We hold a 20% platform fee on every charge, the same rate for all developers.
- **`plan_gated`** is reserved for plugins **we** publish — it is how the five official
  channels are restricted by tier (`TDD_11` §6.5 `AvailableChannels` and `ChannelGuard`).
  A third-party submission with `plan_gated` is rejected by the manifest validator unless
  `Plugin.isOfficial`.

**Submission review checklist** (the staff queue in `TDD_15` §7):
```
- [ ] Manifest schema valid
- [ ] Requested scopes justified by the described functionality
- [ ] Webhook endpoint responds to the verification challenge
- [ ] Settings and widget URLs load over HTTPS
- [ ] Privacy policy and terms of service present and reachable
- [ ] No obfuscated or minified-only client code
- [ ] Rate limits declared and reasonable
- [ ] Tested install and uninstall cycle in a sandbox store
```

---

## 9. Contract tests

Every plugin, official or third-party, must pass the same contract suite. Fixtures are
**per plugin** (captured from the real provider, PII replaced) so the suite stays
channel-agnostic.

```typescript
// tests/contracts/channel-plugin.contract.ts
export interface PluginTestFixtures {
  inboundWebhook: { rawBody: string; headers: Record<string, string>; body: unknown }   // A valid, signed inbound event
  emptyWebhook: unknown                                                                 // A valid payload carrying no events
  invalidSignatureHeaders: Record<string, string>
  context: ChannelContext                                                               // Dummy credentials the plugin's schema accepts
  sendParams: SendMessageParams
}

export function testChannelPluginContract(createPlugin: () => ChannelPlugin, fixtures: PluginTestFixtures): void {
  describe('ChannelPlugin contract', () => {
    let plugin: ChannelPlugin
    beforeEach(() => { plugin = createPlugin() })

    it('declares required identity fields', () => {
      expect(Object.values(ChannelType)).toContain(plugin.id)
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(plugin.capabilities.length).toBeGreaterThan(0)
    })

    it('implements every method its capabilities require', () => {
      if (plugin.capabilities.includes(ChannelCapability.TEMPLATES)) {
        expect(typeof plugin.sendTemplate).toBe('function')
        expect(typeof plugin.listTemplates).toBe('function')
      }
      if (plugin.capabilities.includes(ChannelCapability.MESSAGING_WINDOW)) {
        expect(plugin.messagingWindow).not.toBeNull()
      }
    })

    it('rejects an invalid webhook signature', () => {
      expect(plugin.validateWebhookSignature(fixtures.inboundWebhook.rawBody, fixtures.invalidSignatureHeaders)).toBe(false)
    })

    it('accepts a valid webhook signature', () => {
      expect(plugin.validateWebhookSignature(fixtures.inboundWebhook.rawBody, fixtures.inboundWebhook.headers)).toBe(true)
    })

    it('normalizes a webhook into valid ChannelEvent objects with a recipient', async () => {
      const events = await plugin.handleWebhook(fixtures.inboundWebhook.body)

      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        expect(Object.values(ChannelEventTypes)).toContain(event.type)
        expect(event.connectionId).toBeTruthy()
        expect(event.channelIdentity).toBeTruthy()
        expect(() => new Date(event.timestamp).toISOString()).not.toThrow()
        if (event.message) {
          expect(event.message.externalId).toBeTruthy()
          expect(Object.values(MessageType)).toContain(event.message.type)
        }
      }
    })

    it('handles an empty webhook payload without throwing', async () => {
      await expect(plugin.handleWebhook(fixtures.emptyWebhook)).resolves.toEqual([])
    })

    it('handles garbage without throwing', async () => {
      await expect(plugin.handleWebhook({ unexpected: true })).resolves.toEqual([])
    })

    it('returns a normalized result from sendMessage', async () => {
      const result = await plugin.sendMessage(fixtures.context, fixtures.sendParams)   // Provider HTTP is mocked by the fixture setup
      expect(result.externalId).toBeTruthy()
      expect(Object.values(DeliveryStatus)).toContain(result.status)
      expect(() => new Date(result.sentAt).toISOString()).not.toThrow()
    })
  })
}
```

```typescript
// libs/channels/whatsapp/src/whatsapp.plugin.contract.spec.ts
testChannelPluginContract(() => createWhatsAppPluginForTest(), whatsappFixtures)
```

**This suite is the definition of the SDK.** If a change breaks it,
the change breaks every plugin.

---

## 10. Channel connection management

```
Settings → Channels → WhatsApp Business

Status:        Connected
Phone:         +503 2222-3333
Business:      Mi Empresa SV
Last healthy:  2 minutes ago

[Test connection]  [Reconnect]  [Disconnect]
```

**Connect flow** (`POST /channels/:pluginId/connect`, guards: `ChannelGuard` +
`QuotaGuard(CHANNELS)` from `TDD_11` §3/§6.5, resolved from the `pluginId` param):

```
1. plugin.connect(input) → ConnectResult
2. ChannelConnection.upsert on (pluginId, connectionId):
     - belongs to THIS store → update credentials/metadata, status ACTIVE
     - belongs to ANOTHER store → RESOURCE_CONFLICT ("this number is connected to another account")
3. credentials encrypted with AES-256-GCM (libs/core/crypto, CREDENTIALS_ENCRYPTION_KEY)
4. CHANNEL_CONNECTED event, audit CHANNEL_CONNECTED
```

**Health monitoring** (`Schedules.CHECK_CHANNEL_HEALTH`, worker, leader-locked):
```typescript
@Cron(Schedules.CHECK_CHANNEL_HEALTH)
async checkChannelHealth(): Promise<void> {
  await this.locks.withLock(LockNames.CHECK_CHANNEL_HEALTH, 240, async () => {
    const connections = await this.prisma.client.channelConnection.findMany({
      where: { status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] } },
    })

    for (const connection of connections) {
      const plugin = this.registry.get(connection.pluginId as ChannelType)
      const ctx = await this.channels.contextFor(connection)               // Decrypts credentials for this call only
      const health = await plugin.healthCheck(ctx)

      if (!health.healthy && connection.status === ChannelConnectionStatus.ACTIVE) {
        await this.channels.markConnectionError(connection.pluginId as ChannelType, connection.connectionId, { error: health.error })
        // → status ERROR, CHANNEL_DISCONNECTED event → NotificationTypes.CHANNEL_DISCONNECTED (error severity) to admins
      } else if (health.healthy && connection.status === ChannelConnectionStatus.ERROR) {
        await this.channels.markHealthy(connection.id)                      // CHANNEL_HEALTH_RESTORED
      } else if (health.healthy) {
        await this.prisma.client.channelConnection.update({ where: { id: connection.id }, data: { lastHealthyAt: new Date() } })
      }
    }
  })
}
```

A disconnected channel triggers an error-severity notification to store admins
through in-app, push and email — this is revenue-affecting.
