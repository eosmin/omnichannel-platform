# TDD 10 — Plugin Architecture & Channels

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
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
  readonly id: string                      // 'whatsapp' — the id of a registered plugin (§6.7); the official ones are the ChannelType constants. Also the Plugin.id and ChannelConnection.pluginId
  readonly name: string                    // 'WhatsApp Business'
  readonly version: string                 // '1.0.0'
  readonly author: string
  readonly type: 'channel'                 // v1.2: the SDK also has type 'carrier' (CarrierPlugin, TDD_17 §4.1), held by its own CarrierRegistry
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
  messageId?: string                      // Message.id of a message the platform sent (§6.7.5): lets a remote plugin's status event find it
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
  private readonly plugins = new Map<string, ChannelPlugin>()   // keyed by plugin id: the official ids and those of remote plugins (§6.7)

  constructor(@InjectPinoLogger(PluginRegistry.name) private readonly logger: PinoLogger) {}

  register(plugin: ChannelPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new PlatformException(ErrorCodes.PLUGIN_ALREADY_REGISTERED, `Plugin ${plugin.id} already registered`, 500)
    }
    this.validateContract(plugin)
    this.plugins.set(plugin.id, plugin)
    this.logger.info({ pluginId: plugin.id, version: plugin.version }, 'plugin registered')
  }

  get(pluginId: string): ChannelPlugin {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) {
      throw new PlatformException(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin ${pluginId} not found`, 404)
    }
    return plugin
  }

  list(): ChannelPlugin[] {
    return [...this.plugins.values()]
  }

  hasCapability(pluginId: string, capability: ChannelCapabilityType): boolean {
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

`PluginsModule.forRoot({ channels, carriers })` registers the classes it is given (default: the official lists, `OFFICIAL_CHANNEL_PLUGINS` and `OFFICIAL_CARRIER_PLUGINS`); `list` takes the store (`list(storeId)`) and a carrier registry sits beside this one (`MVP_TRIM_CHECKLIST.md`, "Plugin SDK build details").

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
  ├─ continue the customer's conversation on this channel: wake it if snoozed, reopen it if resolved or archived;
  │  create one only if there is none (or, when StoreSettings.reopenWindowDays is set, it has been quiet longer than that)
  ├─ create Message (unique on conversationId + channelMessageId — duplicates are no-ops)
  ├─ enqueue FETCH_INBOUND_MEDIA when the message carries media
  ├─ record BillableConversation (24h window, idempotent) — quota is checked here
  ├─ apply routing rules (assignment) on a NEW conversation, and on a reopened one that has no assignee or whose assignee left
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
    @Param('pluginId', new ZodValidationPipe(registeredChannelSchema)) pluginId: string,   // an id the registry knows; a remote plugin has no webhook route here (§6.7)
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
    @Param('pluginId', new ZodValidationPipe(registeredChannelSchema)) pluginId: string,   // an id the registry knows; a remote plugin has no webhook route here (§6.7)
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
      opts: { jobId: inboundJobId(pluginId, event) },     // sha256(pluginId|connectionId|type|externalId), length-prefixed (§6.7.5) — provider retries collapse
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
  async handleMessageReceived(pluginId: string, event: ChannelEvent): Promise<void> {
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

    // 3. Find the conversation: open → same; resolved or archived → reopen; snoozed → wake;
    //    none (or quiet longer than reopenWindowDays, when set) → create. Returns whether it was created.
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
  "icon": "https://cdn.acme.com/telegram.png",
  "pricing": { "model": "free" },
  "scopes": [
    "conversations:read",
    "conversations:write",
    "messages:read",
    "messages:write",
    "customers:read",
    "webhooks:write",
    "channel:connections",
    "channel:events"
  ],
  "capabilities": ["text", "image", "reply_to", "delivery_receipts"],
  "channel": {
    "label": "Telegram",
    "commandsUrl": "https://acme.com/platform/commands"
  },
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

`capabilities` values are `ChannelCapability` values (for a channel plugin, only those of §6.7.2; its `channel` block is §6.7.2 too); `webhooks.events` are `Events`
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
  CHANNEL_CONNECTIONS: 'channel:connections',   // §6.7: register and remove the connections of a channel plugin
  CHANNEL_EVENTS: 'channel:events',             // §6.7: report what customers write and what happened to what was sent
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
  [PluginScopes.CHANNEL_CONNECTIONS]: [],   // grants no human permission: only the routes of §6.7, for the connections of the plugin itself
  [PluginScopes.CHANNEL_EVENTS]:      [],
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

### 6.7 Channel plugins by manifest (decided 2026-10-26)

A channel can be added without changing the code of the platform. The plugin runs outside it, in
its own service; the platform sees it through an adapter that implements `ChannelPlugin` (§2) by
talking HTTP. Everything else (the inbound pipeline of §4, the outbound queue, the health
scheduler, the messaging window, routing, realtime) treats it as it treats an official plugin. The
channel is the id of the plugin: a string that the registry vouches for, not a value of a closed enum
(`MVP_TRIM_CHECKLIST.md`, "Open channel ids").

**Principles.** The platform owns the data; the plugin owns the provider. The credentials of the
provider (a session, a token, a QR pairing) stay in the plugin and are never sent to the platform.
The store is always the one of the API key, never one named in a payload. Every call in either
direction is over HTTPS, authenticated, size-limited and rate-limited. A plugin that is slow, down
or hostile can lose its own messages, never another store's data and never the platform's.

#### 6.7.1 Names this section introduces

| Name | Where | Meaning |
| --- | --- | --- |
| `ChannelIds` | `libs/core/domain` | The ids of the official plugins (`whatsapp`, `instagram`, `messenger`, `web_widget`, `email`) as constants. `ChannelType` is kept as an alias of this list for the code that is about official channels only. |
| `CHANNEL_ID_PATTERN` | `libs/core/domain` | `^[a-z][a-z0-9_-]{2,31}$`: what an id must look like. |
| `officialChannelSchema` | `libs/core/domain` | Zod: one of `ChannelIds`. For the public webhook route of §4, which exists only for official plugins. |
| `registeredChannelSchema` | `libs/plugins/runtime` | Zod: a string that matches `CHANNEL_ID_PATTERN` **and** that the registry knows, for the routes that take a channel (filters, routing conditions, the connection routes of §10). |
| `RemoteChannelPlugin` | `libs/plugins/runtime` | The adapter of this section. |
| `OUTBOUND` | `QueueNames`, `TDD_07` | The queue of messages to send (Step 2.6), for official and remote plugins alike (§6.7.5). |

#### 6.7.2 Manifest

A manifest with `"type": "channel"` carries a `channel` block (validated by `pluginManifestSchema`):

```json
"icon": "https://acme.com/telegram.png",
"channel": {
  "label": "Telegram",
  "commandsUrl": "https://acme.com/platform/commands",
  "messagingWindow": { "hours": 24 }
}
```

- `id` of the manifest is the channel id. It must match `CHANNEL_ID_PATTERN`, must not be one of
  `ChannelIds` and must not be registered already. The validator checks the constants as well as the
  `plugins` table, because the official plugins have no row there.
- `label`: 1 to 40 characters, one line, shown as it is (a plugin does not translate its name).
- `icon` is the top-level field of §6.1 (there is no second one inside `channel`). PNG, JPEG or SVG
  of at most 64 KB, fetched once when the plugin is registered (`assertPublicHttpsUrl`, no redirects,
  checked by its bytes and not by its extension). The platform **never serves the original**: it
  decodes it and stores a 128 by 128 PNG (`sharp`; an SVG is rasterised, so no script or external
  reference of it can ever run), under a platform-level key `plugin-icons/{pluginId}.png` kept in
  `Plugin.iconKey`. The UI shows it as an `<img>` from a signed URL.
- `commandsUrl`: HTTPS and public (`assertPublicHttpsUrl`, re-checked at every call).
- `messagingWindow`: optional; absent means the channel has no window. `hours` is an integer from 1
  to 720. `requiresTemplateWhenClosed` is not accepted (a remote plugin cannot send templates, so a
  closed window means "cannot send"); the core fills it in as `false`.
- `capabilities` may hold: `text`, `image`, `video`, `audio`, `document`, `reply_to`,
  `delivery_receipts`, `read_receipts`, `typing_indicator`, `customer_typing`. What each one turns
  on: `delivery_receipts` and `read_receipts` let the plugin report `message_delivered` and
  `message_read` (and, with `read_receipts`, receive `message.markRead`); `typing_indicator` makes the
  platform send `typing.send` when an agent types; `customer_typing` lets the plugin report
  `customer_typing` events. A capability that is not on the list (`location`, `templates`, `buttons`,
  `list_picker`, `reactions`, `messaging_window`) is rejected by the validator. An event of a
  capability the plugin did not declare is refused (`400`); a command of one is never sent, and the
  caller who asked for it (an agent who sends a media type the channel lacks) gets `409`
  `CHANNEL_CAPABILITY_UNSUPPORTED`.
- `scopes` must hold `channel:connections` and `channel:events` (§6.2). Other scopes are granted
  only if the plugin asks and the owner consents, as for any plugin.
- `limits.maxRequestsPerMinute` is the plugin's request, kept between 1 and 600 by the platform
  (default 60) and stored as `PluginInstallation.rateLimitPerMinute`. Whatever it declares, an
  installation is also held to 3000 events a minute.
- `webhooks` is optional for a channel plugin. If present it works as in §6.5, with the scheme and
  the secret of the webhooks, and has nothing to do with the commands below.

#### 6.7.3 Installation, registry and secrets

The installation of §6.3 plus a **command secret** (32 random bytes), generated with the API key,
shown once in the setup handshake and stored encrypted in the new column
`PluginInstallation.commandSecret` (`Bytes`, encrypted as `Webhook.secret` is). One installation
belongs to one store and may hold up to 20 active connections. The migration of Step 5.6 adds
`commandSecret`, `commandSecretPrevious` (`Bytes?`) with `commandSecretRotatedAt`, `Plugin.manifest`
(the validated manifest, `Json`) and `Plugin.iconKey`, with their rollback.

*Rotation.* Rotating the secret keeps the previous one valid for 10 minutes: for that time every
command carries both signatures (§6.7.4), so what is already queued is not interrupted, and the
plugin verifies against any it knows. Rotating the API key invalidates the old one at once.

*Registry.* `PluginRegistry` is per process and holds the official plugins plus a
`RemoteChannelPlugin` for each plugin that has at least one `ACTIVE` installation. The api and the
worker both build it from `plugins` and `plugin_installations` at start, publish every change
(install, revoke, suspend, a new manifest, a rotation) on the Redis channel `plugins:changed`, and
re-read everything every 60 seconds in case a message was lost. `register` of an id that is a
`RemoteChannelPlugin` replaces it (a new manifest), and `unregister(id)` removes it; an official id
is never replaced. `registry.list()` takes the store: it returns the official plugins and the
remote ones that this store has installed, never another store's private plugin. The adapter is
the same object for all stores; what is per store (the command secret, the URL) it takes from the
installation of `ctx.storeId`, read through a cache of 60 seconds that the same Redis channel clears.

The owner links an account of the provider on the settings page of the plugin (`ui.settings` of the
manifest, in the plugin's service: a QR to scan, a login). When that succeeds the plugin registers
the connection (§6.7.5). The platform never sees what was entered there.

#### 6.7.4 Platform to plugin: commands

One endpoint, `POST commandsUrl`, `Content-Type: application/json`, a body of at most 256 KB:

```json
{ "command": "message.send", "storeId": "…", "connectionId": "…", "data": { … } }
```

Headers: `X-Platform-Command-Signature: t=<unix seconds>,v1=<hex>` where the hex is the HMAC-SHA256 of
`"<t>.<raw body>"` with the command secret (while a rotation is open there are two `v1=` entries, one
per secret), `X-Platform-Delivery: <uuid, one per attempt>`, and `Idempotency-Key` for a send. This
header and this secret have nothing to do with the webhooks of §6.5 (those keep the scheme of
`TDD_07 §2` and their own secret). The plugin must reject a signature that matches none of its
secrets (constant-time compare) and a `t` more than 5 minutes from its clock, and must treat
`Idempotency-Key` as a promise: the same key never sends twice, and it remembers keys for at least 24
hours. The platform follows no redirects, waits at most 10 seconds and reads at most 64 KB of the
answer (it aborts the rest).

| `command` | `data` | Answer (HTTP 200 unless said) |
| --- | --- | --- |
| `message.send` | `messageId`, `channelIdentity`, `type` (`text`, `image`, `video`, `audio`, `document`), `content?`, `replyToExternalId?`, `media?: { url, contentType, filename }` | `{ "externalId": "…", "status": "sent", "sentAt"?: ISO 8601 }` |
| `connection.health` | `{}` | `{ "healthy": true }` or `{ "healthy": false, "error": "…" }` |
| `connection.disconnect` | `{}` | `{}`; sent when the owner disconnects it on the platform; best effort, never retried |
| `typing.send` | `channelIdentity`, `state` (`start` or `stop`) | `{}`. Only with `typing_indicator`. Best effort: 3 seconds, never retried. The platform sends one `start` at most every 5 seconds per conversation and a `stop` when the agent stops, sends or leaves the conversation, so a plugin that needs it to expire sets its own timeout |
| `message.markRead` | `channelIdentity`, `externalId` | `{}`. Only with `read_receipts`. Best effort: 3 seconds, never retried. Sent when an agent reads a message of the customer |

`media.url` of an outbound message is a signed GET of the platform's storage that expires in 10
minutes. A refusal is an HTTP 4xx or 5xx with
`{ "error": { "code": "…", "message": "…", "retryable"?: true | false } }`, where `code` is one of
`recipient_invalid`, `window_closed`, `not_connected`, `rate_limited`, `rejected`. The platform maps
it: `window_closed` is `CHANNEL_WINDOW_EXPIRED`, `not_connected` is `CHANNEL_NOT_CONNECTED`, the rest
`CHANNEL_MESSAGE_FAILED`; the message is stored `failed` with that code in `deliveryError`.

*The adapter, method by method.* `sendMessage` and `sendMedia` are `message.send` (`sentAt` is the
plugin's if it gives one, else the moment of the answer); `healthCheck` is `connection.health`
(`checkedAt` is the platform's clock); `disconnect` is `connection.disconnect`;
`sendTypingIndicator` is `typing.send` and `markAsRead` is `message.markRead`, present only when the
capability is declared; `fetchMedia` is the fetch of §6.7.6. `connect` does not exist for a remote
plugin: `POST /channels/:pluginId/connect` (§10) answers `409` with the `ui.settings` URL, because the
connection is made in the plugin. `validateWebhookSignature` and `handleWebhook` are not used: there
is no `/webhooks/channels/` route for a remote plugin (the route validates with
`officialChannelSchema`, so its id is a `404` like any unknown one), and its events arrive at
`POST /events`. The contract suite of §9 does not apply to the adapter; §6.7.9 is its suite.

*Retries.* A send is a job of the `OUTBOUND` queue, whose policy is the same for every plugin: 5
attempts, exponential backoff from 5 seconds. A network error, a timeout, an HTTP 429 or 5xx is tried
again; any other answer is final. If the plugin says `retryable`, the flag wins over the status
(`retryable: true` on a 4xx is tried again, `retryable: false` on a 5xx is not). After the last
attempt the message is `failed`. **Sending again** is the agent's choice and reuses the same
`Message`: it goes back to `queued` and is sent with `Idempotency-Key = <Message.id>.<n>`, where `n`
counts the resends (the first send, and all its automatic attempts, use `<Message.id>`). If the
first one had in fact gone out before the plugin answered, the customer gets it twice; the thread
says it is a resend.

#### 6.7.5 Plugin to platform: the API

Base `/api/v1/plugin-api/channel`, `PluginApiKeyGuard` (§6.4), HTTPS only. The store and the
plugin are those of the key. All the answers of the errors below use the codes that exist:
`VALIDATION_FAILED`, `RESOURCE_CONFLICT`, `CHANNEL_CONNECTION_NOT_FOUND`, `PLUGIN_SCOPE_DENIED`.

- `PUT /connections/:connectionId` (scope `channel:connections`), body
  `{ "displayName": "…" (1 to 100), "metadata"?: {…} (at most 4 KB) }`. Creates or updates the
  `ChannelConnection` of this plugin and store, with empty credentials (the column stays, its content
  is empty). `connectionId` is the plugin's own identifier of the account: at most 128 characters of
  `A-Za-z0-9._:+@-`. `201` when new, `200` when it existed, and a connection that was
  `DISCONNECTED` in this store is reactivated (`200`). `409` `RESOURCE_CONFLICT` when that
  `connectionId` of this plugin belongs to another store (an account is linked to one store at a
  time, `@@unique([pluginId, connectionId])`; to move it the plugin uses a new `connectionId`) and
  when the installation already has 20 active connections (the ones `DISCONNECTED` do not count).
- `DELETE /connections/:connectionId` (same scope): sets it `DISCONNECTED`, keeping the row and its
  conversations. `204`; `404` `CHANNEL_CONNECTION_NOT_FOUND` if it is not one of this installation's.
- `POST /events` (scope `channel:events`), body `{ "events": ChannelEvent[] }`, one to 50 events and
  at most 1 MB. Each event is the `ChannelEvent` of §2, so a remote plugin does what `handleWebhook`
  does for an official one: it normalises. The types are those of `ChannelEventTypes`.
  - Per-event caps: `channelIdentity` 128 characters, `channelProfile.displayName` 100,
    `message.content` 4096, `message.metadata` 4 KB, `message.media.ref` 2048, one `media` per
    message, `message.timestamp` and `timestamp` between 30 days ago and 5 minutes from now (outside
    is a `400`). The platform uses `min(timestamp, receivedAt)` as the date of a message and of
    `lastInboundAt`, so a clock that runs ahead cannot lengthen a window.
  - `message_received` is a customer's message. `message_delivered`, `message_read` and
    `message_failed` are about a message the platform sent: they carry its `messageId` (the
    `data.messageId` of the `message.send`; the field `messageId?` is added to `ChannelEvent`) and/or
    its `externalId`, and are applied **only** if that message belongs to a conversation of a
    connection of this installation; any other is dropped and counted
    (`PLUGIN_EVENT_REJECTED`), never applied to a message of another channel. `message_sent` confirms
    a message the platform sent in the same way (it sets it `sent`); one the platform did not send
    (an echo of what was typed in the provider's own app) is dropped and counted in this version.
    `connection_error` marks the connection `ERROR`. `customer_typing` needs its capability, is not
    queued (it goes to the realtime layer, at most one per conversation every 2 seconds) and nothing
    of it is stored. `message_delivered` and `message_read` need their capabilities.
  - The whole request is validated before anything is queued: one invalid event refuses it (`400`
    `VALIDATION_FAILED` with the issue paths). An event whose `connectionId` is not an active
    connection of this installation refuses it too (`404` `CHANNEL_CONNECTION_NOT_FOUND`, the same
    answer as for one that does not exist). Otherwise `202 { "accepted": n }`, and each event is put
    on the `INBOUND` queue with `jobId = sha256(installationId|connectionId|type|externalId)`
    (hex, the parts length-prefixed, so a `:` or a `|` in an id cannot make two events look the
    same); the connection is part of the id because two accounts can number their messages alike. The
    job id is a best-effort guard while the job is in Redis; the unique index
    `(conversationId, channelMessageId)` of `Message` is what makes a duplicate harmless afterwards.
    From there it is the same as an official channel's event.

The limit of `rateLimitPerMinute` (requests) and the ceiling of 3000 events a minute apply to all
three calls together; past either the answer is `429` with `Retry-After`.

#### 6.7.6 Media

*In.* `message.media.ref` of a remote plugin is a public HTTPS URL, checked when the event arrives
and again when `FETCH_INBOUND_MEDIA` runs. The fetch uses `assertPublicHttpsUrl` with the resolved
addresses pinned in the agent's `lookup` (as `TDD_07 §2` does for webhooks, against DNS rebinding),
follows **no** redirect (a 3xx is a failure), waits 30 seconds, and keeps to the size and type limits
of `TDD_07 §6` for the media of a message. It carries `X-Platform-Command-Signature` (over an empty
body) only if the host is the one of `commandsUrl`, so the plugin can keep its own URLs private and
the signature is never sent to a third-party host. What is fetched goes through the same scan and
processing as any media. A URL that fails leaves the message without its attachment, marked as
failed to fetch, and never loses the message.

*Out.* `media.url` of a send is a signed GET of the platform's storage, 10 minutes.

#### 6.7.7 Health and revocation

`CHECK_CHANNEL_HEALTH` (§10) enqueues one job per connection of a remote plugin (concurrency 10), so
a slow plugin delays only its own checks and not the lock of the others. Each job calls
`connection.health` through the adapter. A failure (unhealthy, error or timeout) adds to a counter
kept in Redis (`CacheKeys.channel.healthFailures(connectionId)`, 1 hour); three in a row put the
connection in `ERROR` (agents see the banner of the channel) and a healthy one clears the counter and
puts it back to `ACTIVE`. An official plugin keeps the behaviour of §10. Revoking or suspending the
installation (§6.6) invalidates the API key and the secrets at once, sets its connections
`DISCONNECTED`, and what was queued for them fails with `CHANNEL_NOT_CONNECTED`.

#### 6.7.8 What a remote plugin cannot do

It cannot read or write a store other than its own, choose the store of an event, send a message on
a connection that is not its own, change the state of a message of another channel, bypass the
messaging window of its manifest, send templates, buttons, list pickers or reactions, or receive
more of the platform's data than its scopes give (the payloads are redacted as in §6.5). Anything
outside this section is outside this version.

#### 6.7.9 Tests

`tests/contracts/remote-channel.contract.ts` replaces the suite of §9 for a remote plugin. It holds a
reference plugin (a small HTTP server of the suite that signs and verifies as §6.7.4 asks) and the
checks of the adapter: signature, both secrets during a rotation and the replay window, the mapping of
errors and `retryable`, retries and final failures, the idempotency key and the resend keys, health
and its counter, the caps and the rate limits, an event for a connection of another store, a status
event for a message of another channel, an invalid event, the lifecycle of a connection (new,
reactivated, taken by another store, over the limit), a media URL that points to a private address or
redirects, and the registry (a new manifest replaces, a revocation removes, the list per store). The
same fixtures are what a plugin author runs against their service.

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

Every official plugin, and every in-process third-party plugin, must pass the same contract suite; a plugin that runs outside the platform (§6.7) passes the suite of §6.7.9 instead. Fixtures are
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
      expect(plugin.id).toMatch(CHANNEL_ID_PATTERN)   // ^[a-z][a-z0-9_-]{2,31}$; an official plugin's id is also one of ChannelIds
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

> A remote channel plugin (§6.7) registers its connections itself (`PUT /plugin-api/channel/connections/:connectionId`); `POST /channels/:pluginId/connect` answers `409` with its `ui.settings` URL. Its health checks are one job per connection with a counter of three failures (§6.7.7).

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
      const plugin = this.registry.get(connection.pluginId)
      const ctx = await this.channels.contextFor(connection)               // Decrypts credentials for this call only
      const health = await plugin.healthCheck(ctx)

      if (!health.healthy && connection.status === ChannelConnectionStatus.ACTIVE) {
        await this.channels.markConnectionError(connection.pluginId, connection.connectionId, { error: health.error })
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
