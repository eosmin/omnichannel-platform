# TDD 10 — Plugin Architecture & Channels

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: plugin SDK, registry, official channel plugins, third-party plugins, widgets

---

## 1. Core concept

**WhatsApp, Instagram, Messenger and the web widget are plugins.** They are built
against the same public SDK that third-party developers will use. The messaging core knows
nothing about any specific channel.

```
┌──────────────────────────────────────────────────────────┐
│                     Messaging Core                       │
│  Conversations · Messages · Customers · Billing          │
│  Knows nothing about WhatsApp or Instagram               │
└────────────────────────┬─────────────────────────────────┘
                         │ ChannelPlugin interface
   ┌──────────┬──────────┼──────────┬───────────┐
   │          │          │          │           │
┌──▼────┐ ┌───▼────┐ ┌───▼────┐ ┌───▼─────┐ ┌───▼───────┐
│WhatsApp│ │Instagram│ │Messenger│ │Web widget│ │Third-party│
│official│ │official │ │official │ │ official │ │(Telegram) │
└────────┘ └─────────┘ └─────────┘ └──────────┘ └───────────┘
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
// libs/core/domain/channel-capability.ts (re-exported by the SDK, so the browser can ask for a capability by name)
export const ChannelCapability = {
  TEXT: 'text',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  LOCATION: 'location',
  CONTACTS: 'contacts',
  BUTTONS: 'buttons',
  LIST_PICKER: 'list_picker',
  TEMPLATES: 'templates',
  TYPING_INDICATOR: 'typing_indicator',
  READ_RECEIPTS: 'read_receipts',
  DELIVERY_RECEIPTS: 'delivery_receipts',
  REACTIONS: 'reactions',
  DELETE_MESSAGE: 'delete_message',          // requires deleteMessage()
  EDIT_MESSAGE: 'edit_message',              // requires editMessage()
  REPLY_TO: 'reply_to',
  MESSAGING_WINDOW: 'messaging_window',
  CUSTOMER_TYPING: 'customer_typing',
  CUSTOMER_PROFILE: 'customer_profile',      // requires fetchProfile() and, usually, profileSetupKey
  CAPTION_PER_FILE: 'caption_per_file',      // a text under each file (SendMediaParams.caption); without it the worker sends the text as its own message
  NAMES_INBOUND_FILES: 'names_inbound_files' // the channel gives the id of each file its customer sends (ids of one message must differ)
} as const

export type ChannelCapabilityType = typeof ChannelCapability[keyof typeof ChannelCapability]
```

```typescript
// libs/plugins/sdk/src/channel-plugin.interface.ts
export interface ChannelPlugin {
  // Identity
  readonly id: string                      // 'whatsapp' — the id of a registered plugin (§6.7); the official ones are the ChannelIds constants. Also the Plugin.id and ChannelConnection.pluginId
  readonly name: string                    // 'WhatsApp Business'
  readonly version: string                 // '1.0.0'
  readonly author: string
  readonly type: 'channel'                 // v1.2: the SDK also has type 'carrier' (CarrierPlugin, TDD_17 §4.1), held by its own CarrierRegistry
  readonly capabilities: readonly ChannelCapabilityType[]
  readonly limits: ChannelLimits           // longest text, and what goes under a file; applied by the core and again by the worker
  readonly identityKind: ChannelIdentityKind   // how a customer's handle is read: 'phone' (compared as digits) or 'opaque'
  readonly receivesProviderWebhooks: boolean   // false for a channel reached by its own client (the web widget)
  readonly connectFields: readonly ConnectField[]   // the connect form; declaring does not validate, `connect` still checks

  // How the channel is named and drawn, with no channel named in the web (§6.7.2); all optional
  readonly displayName?: LocalizedText
  readonly iconKey?: ChannelIconKey
  readonly anonymousCustomers?: boolean    // customers have no name or handle a person would know (a visitor)
  readonly managementSurface?: ChannelManagementSurface   // a page of its own in the settings
  readonly connectHelp?: readonly LocalizedText[]         // the steps the owner takes at the provider before the form
  readonly imageHosts?: ChannelImageHosts  // where the browser may load the channel's pictures from; the CSP is built from these
  readonly profileSetupKey?: string        // message key of a provider-side step needed to read a customer's profile (CUSTOMER_PROFILE only)
  readonly oauth?: ChannelOAuth            // the provider's own login (§2.x); in-process plugins only

  // Declared messaging-window policy, applied by the CORE (§4) — the plugin has no database
  readonly messagingWindow: MessagingWindowPolicy | null

  // The files the channel takes (Step 7.8 follow-up, media capability map): the types and the largest size of each
  // kind, and the files per message. Required for exactly the kinds declared as capabilities (image, video,
  // audio, document); the registry copies and freezes it at registration. The core gives a plugin the bytes
  // (`SendMediaParams.openFile`) and signs no download link unless the plugin asks: `SendMediaParams.signedUrl(ttlSeconds)` makes a signed
  // GET address of the stored file, for a plugin that is handed an address and not the bytes (a remote plugin, §6.7.4).
  readonly media?: ChannelMediaCapabilities
  // A text under each file (`SendMediaParams.caption`, once per file, in the order of the message) is carried
  // by the channel when it declares CAPTION_PER_FILE; a channel that does not has its text sent as a message
  // of its own after the file (the worker does it; the plugin only sees `sendMedia` and then `sendMessage`).

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
  sendReaction?(ctx: ChannelContext, params: SendReactionParams): Promise<void>   // REACTIONS
  deleteMessage?(ctx: ChannelContext, params: DeleteMessageParams): Promise<void> // DELETE_MESSAGE
  editMessage?(ctx: ChannelContext, params: EditMessageParams): Promise<void>     // EDIT_MESSAGE
  // Read-only, optional: what the provider says about the connection's token; asked at connect and once a day
  inspectToken?(ctx: ChannelContext): Promise<TokenInspection>

  // Inbound
  verifyWebhook?(query: Record<string, string>): string | null   // GET handshake (Meta hub.challenge); null = reject
  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean
  handleWebhook(payload: unknown): Promise<ChannelEvent[]>       // Pure: normalizes, never fetches
  fetchMedia?(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia>   // Provider media needs the connection token
  // Pure: would this plugin fetch this link? Asked BEFORE the core resolves the host, so a refused host is never looked up
  acceptsMediaLink?(mediaRef: string): boolean
  // Name, username and photo link of a customer (CUSTOMER_PROFILE); null is a final answer, a PluginError is a failure
  fetchProfile?(ctx: ChannelContext, channelIdentity: string, signal?: AbortSignal): Promise<ChannelCustomerProfile | null>
}
```

**SDK alignment.** The SDK is the contract; the core reads declarations, never a plugin's name. Every capability, event type and `ChannelPlugin` member of the SDK appears in this section, and `libs/plugins/sdk/src/sdk-docs-alignment.spec.ts` fails when one is added without it, or when a capability-to-method pair the registry enforces is missing from the `validateContract` snippet of §3 (the carrier plugin is the same, against `TDD_17 §4.1`). The agnosticism of the core is held by `pnpm validate:channel-agnostic` and `validate:carrier-agnostic` (CI, pre-push), whose baselines only shrink. The behaviors that exist only for an in-process plugin are listed, not hidden: `oauth` ("Optional login" below, code, not a manifest) and `redactedKeys` (a static of the class, read before the registry exists; a remote plugin cannot declare them yet, tracked in `IMPLEMENTATION_PLAN.md` Step 5.6).

**Supporting types:**

```typescript
// libs/plugins/sdk/src/types.ts
export const ChannelEventTypes = {
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_ECHO: 'message_echo',              // written in the provider's own app, echoed to us
  MESSAGE_REACTION: 'message_reaction',      // someone reacted, or took the reaction back
  MESSAGE_EDITED: 'message_edited',          // edited at the provider
  MESSAGE_DELETED: 'message_deleted',        // deleted at the provider
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
  // business account id, widget site key. Resolves the store (§4).
  connectionId: string
  // The customer's handle on this channel — phone (E.164 without '+'), page-scoped id,
  // widget visitor id.
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
  displayName: string                    // Shown in the UI: phone number, page name, site domain
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

### 2.x Optional login (`ChannelPlugin.oauth`, Step 7.8)

A channel whose provider has its own login may declare `oauth`: `kind` (a `ChannelOAuthKinds` constant), `scopes` (the permissions the dialog asks for, each of a list the core allows for that kind), `authorizationUrl(ctx)` (the address of the provider's dialog for the state and the callback the core gives), `exchangeCode(ctx)` (the token of the PERSON for the code that came back), `grantedScopes(ctx)`, `listAssets(ctx)` and `credentialsFor(ctx)`. A plugin never sees the state or the session: the core makes a state of 256 bits (kept in Redis under its SHA-256, read once with `GETDEL`, with the user, the store, the plugin and, for a repair, the connection), checks that the address the plugin built keeps that state and the callback over https, exchanges the code through the plugin, seals the person's token in a session bound to the same user and store (15 minutes), compares `grantedScopes` with `scopes` (the permission a person cleared is named, in `listAssets` and again in `complete`), and ends in the same `connect` as a pasted token with what `credentialsFor` returns; a login started from a connection ends in `updateToken`, so only the account that connection already is will do. The callback of the api is public (rule 5 of `CLAUDE.md`), never makes a connection and answers a redirect with the opaque id of the session or a reason of the closed list. The registry checks the block at boot, copies it (`PluginRegistry.oauthOf`) and refuses a malformed one; only an in-process plugin can declare it, because a remote plugin (§6.7) is a manifest and carries no code. A plugin without it connects with pasted credentials only, as before.

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
      [ChannelCapability.REACTIONS, 'sendReaction'],
      [ChannelCapability.DELETE_MESSAGE, 'deleteMessage'],
      [ChannelCapability.EDIT_MESSAGE, 'editMessage'],
      [ChannelCapability.CUSTOMER_PROFILE, 'fetchProfile'],
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
  providers: [PluginRegistry, WhatsAppPlugin, InstagramPlugin, MessengerPlugin, WebWidgetPlugin],
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
  readonly id = ChannelIds.WHATSAPP
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

### 5.1.1 Several files in one message: one by one (native albums discarded)

A message of several files is sent as one provider message for each file, in the order the agent gave, through
`sendMedia`; the text under the first file (or the text of the message, sent apart) follows the rules of §5.1. There is
no `media.album` declaration and no `sendAlbum` method: a plugin that still carries them is ignored by the core.

Why (owner, 2026-11-09, MVP): a provider that takes several files as ONE message answers one id for the whole
album, so a reaction or a quote cannot name a picture alone (Graph's `reply_to` takes no picture), and the upload that
an album needs was refused twice on the owner's real account. One message for each file gives every picture its own id,
which is what `targetable`, the reaction under a thumbnail and the quote of one picture need. The core reads that
from the data (each file's `channelMessageId`), never from the channel. The idea may return in phase 2 as a
declaration of the plugin once a provider documents a form that works and names each picture.

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
  readonly id = ChannelIds.INSTAGRAM
  readonly name = 'Instagram Direct'
  readonly capabilities = [
    ChannelCapability.TEXT, ChannelCapability.IMAGE, ChannelCapability.VIDEO,
    ChannelCapability.REACTIONS, ChannelCapability.REPLY_TO, ChannelCapability.MESSAGING_WINDOW,
  ] as const
  // connect(): Instagram business account id + page-scoped access token
}

@Injectable()
export class MessengerPlugin extends MetaChannelPlugin {
  readonly id = ChannelIds.MESSENGER
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
name/email/phone into `channelProfile`. Nobody proves what a visitor types, so an email never links
the visitor to an existing customer: the typed data goes on the visitor's own customer, and a
duplicate is for an agent to merge (`MVP_TRIM_CHECKLIST.md`, Step 3.3 PR D2).

**Transport.** The widget is a client of two public endpoints and one socket namespace,
all authenticated by the site key + visitor id and origin-checked:

| Surface | Purpose |
|---|---|
| `POST /api/v1/widget/bootstrap` `{ siteKey, visitorId }` | Returns store branding, business hours state, a short-lived visitor token, conversation history |
| `POST /api/v1/widget/messages` `{ visitorToken, content, mediaId? }` | Inbound message → **the plugin's `handleWebhook`** path: the controller wraps it as a `ChannelEvent` and enqueues `PROCESS_CHANNEL_EVENT`, exactly like a provider webhook |
| `POST /api/v1/widget/upload-url` | Presigned upload, `purpose: MESSAGE`, same limits (`TDD_07` §6) |
| `/widget` Socket.io namespace (`RoomNames.widgetVisitor`) | Outbound messages and agent typing pushed to the visitor |

Outbound: `WebWidgetPlugin.sendMessage` emits `RealtimeEvents.MESSAGE_SENT` on the visitor's
room and stores the message; if the visitor is offline the message waits in history.

**Capabilities:** `TEXT`, `IMAGE`, `DOCUMENT`, `TYPING_INDICATOR`, `CUSTOMER_TYPING`,
`READ_RECEIPTS`. No messaging window.

**Widget UI** (`apps/widget`, vanilla TS, no framework, < 40 KB gzipped): launcher button,
panel with store name and avatar, message list, composer with attachment, "we're away"
banner from business hours, i18n from `Store.defaultLocale` (`es`/`en`), no inline
styles/scripts (works under strict merchant CSPs). Every autonomous reply carries the
"automated response" label (`TDD_12` §13.2).

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

**Private registration (MVP, D10).** There is no marketplace: the owner pastes the manifest in Settings → Plugins
(`POST /plugins/register`, `SETTINGS_MANAGE_PLUGINS`). `pluginManifestSchema` (`libs/plugins/runtime`) refuses any key it does not
name, bounds every text and list, checks every address for its shape (https, default port, no credentials, a host with a dot or a
public address; the network is asked later, at the install challenge and at each delivery), accepts only the scopes that exist,
`"type": "integration"` and `"pricing": { "model": "free" }`. A manifest may carry `names: { es, en }`, the plain-text name in each
language, which the interface prefers to `name`. The row is stored `approved`, `isOfficial = false`, and belongs to the
organization that registered it (`Plugin.organizationId`): only its stores see it in the catalog and install it. The id is never
an official channel, the shipping plugin, one the registry runs, or one another organization holds. Registering a higher `version` of
one's own plugin replaces the manifest; an installation keeps the scopes it was installed with until the owner approves the new
ones in a consent screen (Step 5.6, install flow).

**Deleting a registered plugin (Step 5.6, PR W1-2).** `DELETE /plugins/:id` (`SETTINGS_MANAGE_PLUGINS`, a body `{ confirmation }` with the
name of the plugin as registered, typed as the person sees it: the case counts, the space around it does not) removes a plugin the
organization registered. A plugin of another organization, an official one and one that does not exist answer the same 404, before the
name is looked at. It is refused with 409 `PLUGIN_IN_USE` while any store of the organization holds an installation that is not
revoked, a revoked one that still has its webhook endpoint or secret (the last `plugin.revoked` delivery has not been sent), or one that
still has channel connections (the history of a channel: its conversations stay). When none does, the plugin row and the rows of its
revoked installations (with their delivery log) go in one transaction, under the same lock of the organization as a registration, and the
action `plugin.deleted` is audited with the plugin id, its type and the number of installations removed (nothing of a key or a secret,
which a revoked installation no longer has). What the plugin wrote (messages, reactions, audit entries) stays, named by its id. The id is
free again for the organization (and for another one).

### 6.2 Scopes

```typescript
export const PluginScopes = {
  CONVERSATIONS_READ: 'conversations:read',
  CONVERSATIONS_WRITE: 'conversations:write',
  MESSAGES_READ: 'messages:read',
  MESSAGES_WRITE: 'messages:write',
  MESSAGES_WRITE_AS_AGENT: 'messages:write-as-agent', // writing a message as a member of the team (`authorType: agent` + `userId`); needs messages:write too
  MESSAGES_READ_DELETED: 'messages:read-deleted', // the text of a message the customer deleted, while it is kept
  MESSAGES_DELETE: 'messages:delete', // deleting and discarding a message the plugin wrote (PR M1c)
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  CUSTOMERS_DELETE: 'customers:delete',                 // delete a customer with no history (Step 5.6 E2); CUSTOMERS_DELETE is in no other scope
  CUSTOMERS_FLAG_CAUTION: 'customers:flag-caution',     // set and clear the caution flag (Step 5.6 E2); who edits a customer does not flag it by that
  ORDERS_READ: 'orders:read',
  ORDERS_WRITE: 'orders:write',                 // create an order and change its status (Step 5.6 E3b); never confirm, cancel, edit or decide a price by it
  ORDERS_EDIT: 'orders:edit',                   // edit an order and record a payment by hand (Step 5.6 E3b)
  ORDERS_CONFIRM: 'orders:confirm',             // confirm one order or a selection (Step 5.6 E3b)
  ORDERS_CANCEL: 'orders:cancel',               // cancel an order (Step 5.6 E3b)
  ORDERS_APPROVE_PRICE: 'orders:approve-price', // approve or reject a price that waits for it, never the request the plugin made itself (Step 5.6 E3b)
  PRODUCTS_READ: 'products:read',
  PRODUCTS_WRITE: 'products:write',             // create and change a product or a variant (Step 5.6 E4a); never its cost, and its tax is read, not written
  PRODUCTS_DELETE: 'products:delete',           // delete a product or a variant (Step 5.6 E4a); PRODUCTS_DELETE is in no other scope
  WAREHOUSES_READ: 'warehouses:read',           // the warehouses of the organization of the key's store (Step 5.6 E4a)
  TAGS_READ: 'tags:read',                       // the tag catalog of the store (Step 5.6 E4a-2)
  SNIPPETS_READ: 'snippets:read',               // the canned replies of the store, read only (Step 5.6 E7-2)
  TAGS_WRITE: 'tags:write',                     // create, rename, recolor and delete a tag of the catalog (Step 5.6 E4a-2)
  TRANSFERS_READ: 'transfers:read',             // the transfers between warehouses, read only; the lines of the key's store only (Step 5.6 E4b)
  COUNTS_READ: 'counts:read',                   // the physical counts, read only; the lines of the key's store only (Step 5.6 E4b)
  TRANSFERS_WRITE: 'transfers:write',           // make, change, dispatch and cancel a transfer; only one whose every line is of the key's store (Step 5.6 E4b-2)
  TRANSFERS_RECEIVE: 'transfers:receive',       // receive a transfer and close it with a shortage; a scope of its own as who sends does not receive (Step 5.6 E4b-2)
  COUNTS_WRITE: 'counts:write',                 // open, fill in, submit, reopen and cancel a count; never apply it (Step 5.6 E4b-2)
  COUNTS_APPLY: 'counts:apply',                 // apply a count in review: the stock becomes what was counted, a scope of its own (Step 5.6 E4b-2)
  EXPORTS_READ: 'exports:read',                 // the exports this installation asked for, with the retention and signed link of a person's (Step 5.6 E7); grants no permission
  EXPORTS_WRITE: 'exports:write',               // take data out: ANALYTICS_EXPORT and MEDIA_DOWNLOAD_ALL, with the scope that reads what is exported (Step 5.6 E7)
  MEDIA_READ: 'media:read',                     // signed links of the files of the store (Step 5.6 E7)
  MEDIA_WRITE: 'media:write',                   // upload through the checks of a person's (type, size, scan); message files only (Step 5.6 E7)
  RETURNS_READ: 'returns:read',                 // the returns and the batches of the scanner that receives them, read only; no id of a person, no flag on a customer (Step 5.6 E6)
  REMITTANCES_READ: 'remittances:read',         // the remittances of cash collected on delivery and the saved import profiles, read only; no id of a person, no imported file (Step 5.6 E6)
  CARRIERS_READ: 'carriers:read',               // the carrier connections of the store, read only; never a credential, a secret or an agreed amount (Step 5.6 E5)
  PICKUPS_READ: 'pickups:read',                 // the pickups of the store and, with customers:read and shipments:read, their manifest; read only (Step 5.6 E5)
  WEBHOOKS_WRITE: 'webhooks:write',
  ANALYTICS_READ: 'analytics:read',
  CHANNELS_READ: 'channels:read',               // the directory of channel accounts and their templates (Step 5.6 E1); no connection details
  ORDER_MESSAGES_READ: 'order-messages:read',   // the history of messages about an order and the order templates (Step 5.6 E3a)
  ORDER_MESSAGES_WRITE: 'order-messages:write', // send the message of a kind about an order (Step 5.6 E3b)
  ORDER_TEMPLATES_WRITE: 'order-templates:write', // write, delete and preview an order template (Step 5.6 E3b)
  SETTINGS_READ: 'settings:read',               // the store preferences and the return rules, read only (Step 5.6 E3a)
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
  [PluginScopes.MESSAGES_WRITE_AS_AGENT]: [], // the person written for holds the permission; the service checks it on that person
  [PluginScopes.MESSAGES_READ_DELETED]: [Permissions.MESSAGES_VIEW_DELETED],
  [PluginScopes.MESSAGES_DELETE]: [Permissions.MESSAGES_DELETE],
  [PluginScopes.CUSTOMERS_READ]:      [Permissions.CUSTOMERS_VIEW],
  [PluginScopes.CUSTOMERS_WRITE]:     [Permissions.CUSTOMERS_CREATE, Permissions.CUSTOMERS_EDIT],
  [PluginScopes.CUSTOMERS_DELETE]:    [Permissions.CUSTOMERS_DELETE],
  [PluginScopes.CUSTOMERS_FLAG_CAUTION]: [Permissions.CUSTOMERS_FLAG_CAUTION],
  [PluginScopes.ORDERS_READ]:         [Permissions.ORDERS_VIEW],
  [PluginScopes.ORDERS_WRITE]:        [Permissions.ORDERS_CREATE, Permissions.ORDERS_CHANGE_STATUS],
  [PluginScopes.ORDERS_EDIT]:         [Permissions.ORDERS_EDIT],
  [PluginScopes.ORDERS_CONFIRM]:      [Permissions.ORDERS_CONFIRM],
  [PluginScopes.ORDERS_CANCEL]:       [Permissions.ORDERS_CANCEL],
  [PluginScopes.ORDERS_APPROVE_PRICE]: [Permissions.ORDERS_APPROVE_PRICE],   // never ORDERS_OVERRIDE_PRICE: no scope sets a price outside the catalog
  [PluginScopes.ORDER_MESSAGES_WRITE]: [Permissions.ORDERS_SEND_MESSAGES],
  [PluginScopes.ORDER_TEMPLATES_WRITE]: [Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES],
  [PluginScopes.PRODUCTS_READ]:       [Permissions.PRODUCTS_VIEW],
  [PluginScopes.EXPORTS_READ]:        [],
  [PluginScopes.EXPORTS_WRITE]:       [Permissions.ANALYTICS_EXPORT, Permissions.MEDIA_DOWNLOAD_ALL],
  [PluginScopes.MEDIA_READ]:          [Permissions.MEDIA_VIEW],
  [PluginScopes.MEDIA_WRITE]:         [Permissions.MEDIA_UPLOAD],
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
  3. Create PluginInstallation { status: PENDING_SETUP, scopes granted, webhookEndpoint that passed }
  4. Audit log the installation (PLUGIN_INSTALLED)
  5. Hand the owner a one-time code (5 min, Redis, under its SHA-256) and the plugin's settings URL
  ↓
Plugin exchanges the code (POST /plugin-api/setup/exchange, public: the code is the credential) for its key:
  the key is made at the exchange, plg_live_ + 256 bits; only its first 12 characters and its sha256 are
  stored; it is returned in that answer and never again, with the secret that signs the webhooks when the
  plugin has an endpoint (§6.5); the installation becomes ACTIVE in the same transaction
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

Messages (Step 5.6 PR M1b): `POST /plugin-api/messages` writes a reply (`type: text`) or an internal note (`type: note`) with `authorType` `system` (default: the plugin writes as itself, `authorPluginId` and its nickname) or `agent` (+ `userId`: writes as that member of the team, who must be active in the store and hold the permission; it needs the scope `messages:write-as-agent` as well as `messages:write`, else 403 `PLUGIN_SCOPE_DENIED` once the body is valid and before the member is looked at, MSG-410; editing or sending again a message it wrote as a person needs it too; the thread draws "sent by {plugin} on behalf of {name}"), `quiet` and `nickname`; `POST /plugin-api/messages/:id/resend-caption`, `POST /plugin-api/messages/:id/files/:index/refetch`, `GET /plugin-api/messages/:id/revisions` and `GET /plugin-api/messages/:id/deleted-content` (scope `messages:read-deleted`). Every one of them needs `conversations:read` as well as its own scope, because a plugin sees a conversation as a person with `conversations:view` does. `refetch` returns the message of a customer, so it also needs `messages:read`. The answer of a write names the quoted message by its id only, unless the key holds `messages:read`, and then without the text of an internal note and without the id of any member of the team; reactions of customers are given with `messages:read` and none without it (Step 5.6, HC-011). A plugin's message is audited as `message.plugin_sent` (other changes: `message.plugin_changed`) with the platform as the actor and the plugin and installation on the metadata. Editing, sending again, discarding, reacting and deleting (Step 5.6 PR M1c) record the plugin as the actor (`ActorIdentity`, `libs/core/domain/actor-identity.ts`; the columns `edited_by_plugin_id`, `deleted_by_plugin_id`, `pending_edit_plugin_id` and `message_reactions.plugin_id`, never both a person and a plugin): `PATCH /plugin-api/messages/:id` (`messages:write`), `DELETE /plugin-api/messages/:id` and `POST .../:id/discard` (`messages:delete` as well), `POST .../:id/resend` and `PUT .../:id/reaction` (`messages:write`). A plugin edits, deletes, sends again and discards only the messages it wrote (403 otherwise, whatever it holds); it may react to any message it can see, as the system. A plugin that sends a reply again moves nothing of the conversation.

### 6.5 Outbound webhooks to plugins

The setup exchange (§6.3) also hands the plugin the secret that signs what is sent to it (`whsec_` + 256 bits), when its manifest has a
webhook endpoint: shown once with the key, kept sealed (`PluginInstallation.webhookSecret`, the same cipher as the secret of a
tenant webhook), never in an audit entry. The `WebhookDispatcher` that queues the webhooks of a store looks the installations up in
the same pass:

```typescript
// for an event of the catalog that the bus carries, with the store named in its payload
const installations = await this.prisma.client.pluginInstallation.findMany({
  where: {
    storeId,                                   // the store of the event, never a value of a request
    status: PluginInstallationStatus.ACTIVE,
    webhookEndpoint: { not: null }, webhookSecret: { not: null },
    webhookDisabledAt: null,                   // not turned off by its failures
    plugin: { status: PluginStatus.APPROVED }  // Suspended plugins get nothing (TDD_15 §7)
  },
  select: { id: true, scopes: true, plugin: { select: { manifest: true } } }
})
// one TRIGGER_PLUGIN_WEBHOOK job for each that follows the event (its manifest's `webhooks.events`) and whose scopes cover it,
// with `redactForScopes(event, payload, installation.scopes)` as the payload
```

**Which events, and what each carries** (`libs/plugins/sdk/src/plugin-events.ts`). Only the events a store can follow (the webhook
catalog) are sent to a plugin, and only when the installation holds the scope of the event (`PluginEventScopes`: `order.*` needs
`orders:read`, `customer.*` `customers:read`, `conversation.*` `conversations:read`, `message.*` `messages:read`, `shipment.*`
`shipments:read`, `product.*` `products:read`, `return.*` `returns:read`). What is in the payload is decided field by field: a field is sent only when it is listed, and the id of a resource only
when the installation holds a scope that reads it (`customerId` needs `customers:read`, so a plugin with only `messages:read`
never gets the customer; `orderId` needs `orders:read`, `shipments:read` or `returns:read`). The text of a message, the ids of the people of the
team (the team directory has no scope), the visibility and the flags that steer the platform are never sent, and neither is a
value that is not a plain one. A key an event gains later is held back until someone decides which scope opens it.

**Delivery** is the one of the webhooks of a store (TDD_07 §2, `webhook-sending.ts` in the worker): the body is
`{ event, data, timestamp, deliveryId }`, the signature is `sha256=` + the hex HMAC-SHA256 of that exact text under the installation's
secret, in the header the manifest names (`webhooks.signatureHeader`; `X-Platform-Event` and `X-Platform-Delivery` always), the
post goes only to `PluginInstallation.webhookEndpoint` (the address that passed the install challenge, whatever a newer manifest says),
resolved again at each delivery and connected to only if public. Every try is a row of `WebhookDelivery` (with
`pluginInstallationId`); 20 deliveries in a row that failed for good turn the installation's webhooks off
(`webhookDisabledAt`), raise `plugin.error` and notify whoever holds `settings:manage_plugins`, once. A newer manifest is read for
which events the plugin follows and for the name of the signature header, never for where to send.

### 6.6 Revocation

```
Settings → Plugins → [plugin] → Revoke access
  ↓
Confirmation requires typing REVOKE (an integration plugin; the body `{ "confirmation": "REVOKE" }`, as written)
  ↓
Backend:
  1. In one transaction under the lock of the store: set the installation to REVOKED with revokedAt, and clear the key
     (apiKeyHash, apiKeyPrefix): the guard already refuses a revoked installation at the next call, and there is nothing left to match
  2. Void the setup code, if one was waiting
  3. Audit log (PLUGIN_REVOKED), actor the person
  4. Queue a final `plugin.revoked` webhook (`final: true`), signed with the secret that is still kept
  5. The worker delivers it (or gives up after its tries) and then removes the endpoint and the secret: the subscription is closed;
     a delivery still queued for an earlier event is skipped, because the installation is not active
```

The notification to the store admins of the original design is not built: the person who revokes is one of them and the audit log
records it. Revoking again changes nothing, and finishes what a failed run left (the final webhook has one job id, made of the installation and the moment of the revocation, so it is queued once); the plugin may hear `plugin.revoked` before events that were queued earlier, which are skipped from then on; installing the plugin again starts from `PENDING_SETUP` with no key
and a new secret.

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
| `ChannelIds` | `libs/core/domain` | The ids of the official plugins (`whatsapp`, `instagram`, `messenger`, `web_widget`) as constants. Only the registry policy, the composition of the official plugins, fixtures and tests name them (Step 7.9). |
| `CHANNEL_ID_PATTERN` | `libs/core/domain` | `^[a-z][a-z0-9_-]{2,31}$`: what an id must look like. |
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
  "messagingWindow": { "hours": 24 },
  "connectFields": [
    { "key": "accountName", "label": { "es": "Nombre de la cuenta", "en": "Account name" },
      "secret": false, "required": true, "multiple": false }
  ]
}
```

- `id` of the manifest is the channel id. It must match `CHANNEL_ID_PATTERN`, must not be one of
  `ChannelIds` and must not be registered already. The validator checks the constants as well as the
  `plugins` table: since D19 the official plugins have a row there too, written from the code at boot.
- `label`: 1 to 40 characters, one line, shown as it is (a plugin does not translate its name).
- `icon` is the top-level field of §6.1 (there is no second one inside `channel`). PNG, JPEG or SVG
  of at most 64 KB, fetched once when the plugin is registered (a channel plugin; at most 4 megapixels, and an SVG that
  carries a script, an entity, an embedded document or a reference that is not to a part of the same picture is refused) (`assertPublicHttpsUrl`, no redirects,
  checked by its bytes and not by its extension). The platform **never serves the original**: it
  decodes it and stores a 128 by 128 PNG (`sharp`; an SVG is rasterised, so no script or external
  reference of it can ever run), under a platform-level key `plugin-icons/{pluginId}.png` kept in
  `Plugin.iconKey`. The UI shows it as an `<img>` from a signed URL.
- `connectFields` (optional, at most 20): the fields the owner fills to connect an account, as `ChannelPlugin.connectFields`
  declares them for an official plugin, except that the label is a plain text per language (`label: { es, en }`, each of
  at most 60 characters, no markup and no control character) and never a message key of the web app. A key is an identifier,
  unique, and not one the platform reserves. Settings → Channels draws the label of the language of the person
  (`fieldLabelOf`); the plugin still checks the values.
- `commandsUrl`: HTTPS and public (`assertPublicHttpsUrl`, re-checked at every call).
- `messagingWindow`: optional; absent means the channel has no window. `hours` is an integer from 1
  to 720. `requiresTemplateWhenClosed` is not accepted (a remote plugin cannot send templates, so a
  closed window means "cannot send"); the core fills it in as `false`.
- `capabilities` may hold: `text`, `image`, `video`, `audio`, `document`, `reply_to`,
  `delivery_receipts`, `read_receipts`, `typing_indicator`, `customer_typing`, `caption_per_file`. What each one turns
  on: `delivery_receipts` and `read_receipts` let the plugin report `message_delivered` and
  `message_read` (and, with `read_receipts`, receive `message.markRead`); `typing_indicator` makes the
  platform send `typing.send` when an agent types; `customer_typing` lets the plugin report
  `customer_typing` events. A capability that is not on the list (`location`, `templates`, `buttons`,
  `list_picker`, `reactions`, `messaging_window`) is rejected by the validator. `caption_per_file` means the plugin
  carries the text under each file of a message (the send-file command carries the text of that file); a plugin that does not
  declare it is offered only the one text of the message. A manifest never inherits a capability it did not list. An event of a
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
the same object for all stores; the address of the commands is the `commandsUrl` of the manifest, the same for every store,
and what is per store (the command secret) it takes from the installation of `ctx.storeId`, read through a cache of 60
seconds that the same Redis channel clears. The secret is generated when the installation is set up (the same exchange that
gives the plugin its API key returns it, once) and `POST /plugins/:id/command-secret` (the id is the installation's,
`SETTINGS_MANAGE_PLUGINS`) rotates it, returning the new one once. A rotation is refused (`409`) while another is still open
(the ten minutes below), so a second one cannot drop a secret the plugin has not replaced yet. An installation that is not
`ACTIVE`, or whose secret cannot be read, is signed for by nobody: nothing is sent and the command fails with
`CHANNEL_NOT_CONNECTED`.

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
is no `/webhooks/channels/` route for a remote plugin (the route answers `404` for a channel whose manifest says `receivesProviderWebhooks: false`, like any unknown id), and its events arrive at
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
    (an echo of what was typed in the provider's own app) is a `message_echo` event, stored as an
    outbound message of an external author (Step 2.8, `MVP_TRIM_CHECKLIST.md`).
    `connection_error` marks the connection `ERROR`. `customer_typing` needs its capability, is not
    queued (it goes to the realtime layer, at most one per conversation every 2 seconds) and nothing
    of it is stored. `message_delivered` and `message_read` need their capabilities.
  - The whole request is validated before anything is queued: one invalid event refuses it (`400`
    `VALIDATION_FAILED` with the issue paths). An event whose `connectionId` is not an active
    connection of this installation refuses it too (`404` `CHANNEL_CONNECTION_NOT_FOUND`, the same
    answer as for one that does not exist). Otherwise `202 { "accepted": n }`, and each event is put
    on the `INBOUND` queue with `jobId = inboundJobId(pluginId, event)`, the sha256 of
    `pluginId|connectionId|type|externalId` (hex, the parts length-prefixed, so a `:` or a `|` in an id cannot make two events look the
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

`CHECK_REMOTE_CHANNEL_HEALTH` (the schedule of §10, with a lock of its own) checks the connections of the remote
plugins one by one, ten at a time, so a slow plugin delays its own checks and not the lock of the official ones. Each check calls
`connection.health` through the adapter. A failure (unhealthy, error or timeout) adds to a counter
kept in Redis (`CacheKeys.channel.healthFailures(connectionRowId)`, 1 hour); three in a row put the
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
`window.parent.postMessage` for data. The page posts the INIT once, when the frame fires `load`, so the frame registers its `message` listener synchronously in its first script (a listener added after hydration misses it and the page shows the notice). Once it has the port the frame answers `platform.widget.ready` over it;
a frame that has not by `PluginWidgetTimings.INIT_TIMEOUT_MS` gets a notice in its panel instead of an empty
box. The page sends `platform.widget.session` (the token, its lifetime, the widget id and the conversation id)
over the port when it opens and again before each session ends.

**What v1.2 builds (Step 5.7a).** The page forwards what the frame asks to `POST /api/v1/plugin-widgets/bridge`
on the agent's own session (AuthGuard, TenantGuard, `CONVERSATIONS_VIEW`), with the widget session token the
frame was handed over the port (`POST /api/v1/plugin-widgets/sessions`: 5 minutes, one person, one
installation, one conversation that person may see; only the sha256 of the token is stored). The server
checks the session, reads the installation again (a revoked one stops at once), requires the scope of the
operation (`PluginBridgeOperationScopes`) and the matching permission of the person, and answers only about
the conversation of the session. The operations are a closed set (`conversation.get`, `customer.get`), each
a minimum view; the frame never names a conversation. A widget whose origin is the web app's or the api's
is never listed: `allow-same-origin` is safe only because the frame's origin is not ours. Calling
`/plugin-api/*` straight from the frame with the token joins with Step 5.6.

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
- **`plan_gated`** is reserved for plugins **we** publish — it is how the four official
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

> Since D19 a channel is connected from the installation of its plugin: the store installs it from the catalog (`POST /plugins/install`), `POST /channels/:pluginId/connect` answers `409 PLUGIN_NOT_INSTALLED` without one, and uninstalling (`POST /plugins/:installationId/revoke`) disconnects every connection of the installation, deletes its credentials and keeps the conversations, messages and customers.
>
> A remote channel plugin (§6.7) registers its connections itself (`PUT /plugin-api/channel/connections/:connectionId`); `POST /channels/:pluginId/connect` answers `409` with its `ui.settings` URL. Its health checks are one job per connection with a counter of three failures (§6.7.7).

```
Settings → Channels → WhatsApp Business

Status:        Connected
Phone:         +503 2222-3333
Business:      Mi Empresa SV
Last healthy:  2 minutes ago

[Test connection]  [Reconnect]  [Disconnect]
```

**When the token stops (Messenger and Instagram; owner, 2026-11-07).** A pasted token of a Page can stop
working on a date (the long ones of a user last about 60 days; those of a Page from a login normally do not
stop). A channel plugin may implement the optional `inspectToken(ctx)` (read-only, like `healthCheck`); the
Meta plugins read `GET /debug_token` with the app token `APP_ID|APP_SECRET` (`META_APP_ID`,
`META_APP_SECRET`) and answer `{ kind: page|user|unknown, isValid, expiresAt|null, scopes }`. The core asks
when a connection is made or its token replaced (a short wait; a failure never undoes the connect) and once a
day for the ones due (`CHECK_TOKEN_EXPIRY`, a leader lock, at most `TokenExpiryLimits.RUN_MAX_CALLS` questions
and a time budget per round; a connection is asked about at most every 20 hours, a token that does not expire
every 7 days). The answer is kept in `metadata.tokenInfo` (kind, validity, date, scopes, when it was asked, the
date already announced), written with `jsonb_set` under the lock of the row and only for the credentials that
were asked with: other keys of the metadata are not overwritten and the answer about a replaced token is
dropped. Never the token. The view of a connection answers `tokenExpiry { state: never|expires|expired|
invalid|unknown, expiresAt, checkedAt, kind }`; `unknown` is what is said when Meta could not be asked, and
`expired` only when Meta gave a date that has passed. Within `TokenExpiryLimits.WARN_DAYS` (7) of the date the
people who hold `settings:manage_plugins` get one `channel.token_expiring` notice per date (through the
ordinary notification pipeline, so preferences, the digest and the email suppression apply); a renewed token
arms it again. `isValid: false` is shown on the card and warned in the log, and the health check takes the
connection down on its own round (that is the `channel.disconnected` notice: no second one).
The app token goes in the Authorization header only, never in an address or a log. The token asked about goes
in the body of a POST; `debug_token` documents only GET, so if Meta refuses the POST (an error of class
`GraphMethodException`, or code 100 with subcode 33) the same question is asked with GET and only then does the
token go in the address (never logged, kept or attached to an error). The method that worked is remembered by
the process.

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
