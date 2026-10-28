import type { ChannelCapabilityType } from './channel-capability'
import type {
  ChannelContext,
  ChannelEvent,
  ChannelHealth,
  ChannelMessageResult,
  ConnectInput,
  ConnectResult,
  FetchedMedia,
  MarkReadParams,
  MessageTemplate,
  MessagingWindowPolicy,
  SendButtonsParams,
  SendLocationParams,
  SendMediaParams,
  SendMessageParams,
  SendReactionParams,
  SendTemplateParams,
  TypingParams
} from './channel-types'
import type { PluginTypes } from './plugin-types'

export interface ChannelPlugin {
  // The id of a registered plugin ('whatsapp'); also Plugin.id and ChannelConnection.pluginId.
  // The official ones are the ChannelIds constants.
  readonly id: string
  readonly name: string
  readonly version: string
  readonly author: string
  readonly type: typeof PluginTypes.CHANNEL
  readonly capabilities: readonly ChannelCapabilityType[]

  // Applied by the core: the plugin has no database
  readonly messagingWindow: MessagingWindowPolicy | null

  // Credentials are supplied by the core, encrypted at rest by the core
  connect(input: ConnectInput): Promise<ConnectResult>
  disconnect(ctx: ChannelContext): Promise<void>
  healthCheck(ctx: ChannelContext): Promise<ChannelHealth>

  sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult>
  sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult>

  // Optional, each one required by a declared capability (see the registry)
  sendTemplate?(ctx: ChannelContext, params: SendTemplateParams): Promise<ChannelMessageResult>
  listTemplates?(ctx: ChannelContext): Promise<MessageTemplate[]>
  sendButtons?(ctx: ChannelContext, params: SendButtonsParams): Promise<ChannelMessageResult>
  sendLocation?(ctx: ChannelContext, params: SendLocationParams): Promise<ChannelMessageResult>
  sendTypingIndicator?(ctx: ChannelContext, params: TypingParams): Promise<void>
  markAsRead?(ctx: ChannelContext, params: MarkReadParams): Promise<void>
  sendReaction?(ctx: ChannelContext, params: SendReactionParams): Promise<void>

  // GET handshake (Meta hub.challenge); null rejects it
  verifyWebhook?(query: Record<string, string>): string | null
  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean
  // Pure: normalizes and never fetches
  handleWebhook(payload: unknown): Promise<ChannelEvent[]>
  // Provider media needs the connection token
  fetchMedia?(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia>
}
