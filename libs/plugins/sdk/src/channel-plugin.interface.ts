import { type ChannelMediaCapabilities } from '@platform/core/channel-media'
import type { ChannelIdentityKind, ChannelLimits, TokenInspection } from '@platform/core/domain'

import type { ChannelCapabilityType } from './channel-capability'
import type { ChannelOAuth } from './channel-oauth'
import type {
  ChannelContext,
  ChannelCustomerProfile,
  ChannelEvent,
  ChannelHealth,
  ChannelAlbumResult,
  ChannelMessageResult,
  ConnectField,
  ConnectInput,
  ConnectResult,
  FetchedMedia,
  MarkReadParams,
  MessageTemplate,
  MessagingWindowPolicy,
  SendButtonsParams,
  SendLocationParams,
  SendAlbumParams,
  SendMediaParams,
  SendMessageParams,
  SendReactionParams,
  DeleteMessageParams,
  EditMessageParams,
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

  // The longest text a message takes on this channel, and what goes under a file. Applied by the core
  // before a reply is queued and again by the worker; the registry checks it and keeps a copy.
  readonly limits: ChannelLimits
  // How the handle of a customer is read: a phone (compared as digits) or opaque (kept as sent)
  readonly identityKind: ChannelIdentityKind

  // Applied by the core: the plugin has no database
  readonly messagingWindow: MessagingWindowPolicy | null

  // The fields of the connect form, in the order they are drawn. Declaring them does not validate
  // anything: `connect` still checks what arrives. Empty when nothing is asked (never for a channel
  // that needs an account).
  readonly connectFields: readonly ConnectField[]
  // The provider calls the api (webhooks): the owner must paste the callback url of the channel in the
  // provider's dashboard. False for a channel that is reached by its own client (the web widget).
  readonly receivesProviderWebhooks: boolean
  // Message key of a step the owner takes on the provider's side so that the profile (name, photo) of
  // a customer can be read, shown when the provider refuses it. Only for CUSTOMER_PROFILE channels.
  readonly profileSetupKey?: string
  // The provider's own login, in place of a pasted token (Step 7.8). Only an in-process plugin can declare
  // it (it is code, not a manifest); the core runs the flow and the plugin answers about its provider.
  // Absent for a channel that has no such login.
  readonly oauth?: ChannelOAuth
  // The files the channel takes: the types and the largest size of each kind, and how many go in a message.
  // Required exactly for the kinds of file the channel declares as a capability (`IMAGE`, `VIDEO`, `AUDIO`,
  // `DOCUMENT`), and absent for a channel with none; the registry checks both ways. The plugin refuses a file the channel
  // does not take before opening it; the API will refuse it before queueing once it reads the declaration (the
  // PR of several files per message).
  readonly media?: ChannelMediaCapabilities

  // Credentials are supplied by the core, encrypted at rest by the core
  connect(input: ConnectInput): Promise<ConnectResult>
  disconnect(ctx: ChannelContext): Promise<void>
  // READ-ONLY: it must not subscribe, write or change anything at the provider. The core also runs it on the
  // credentials of a NEW token before accepting it, to learn whether the token is of the account the
  // connection already has, so that a token of another account leaves no trace on that account.
  // Throws a PluginError (with a `failedCheck` or a `reason`) when the account is not the same.
  // The core trusts it to tell the account (it cannot know what a provider calls one), so `connect` must also be
  // harmless for an account that is not the one the connection holds: it runs only after this says it is the same.
  healthCheck(ctx: ChannelContext): Promise<ChannelHealth>
  // Optional, READ-ONLY like `healthCheck`: what the provider says about the token of the connection (whose
  // kind it is, whether it still works and when it stops). The core asks when a connection is made and once a
  // day, and warns the people who set the channel up before it stops. A channel whose token does not expire,
  // or that the provider cannot be asked about, leaves it out. A failure is thrown and means "could not ask":
  // it never marks the token as expired.
  inspectToken?(ctx: ChannelContext): Promise<TokenInspection>

  sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult>
  sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult>

  // Several files in one message. Required exactly when `media.album` is declared (the registry checks both ways).
  // All or nothing: it is one call to the provider. A failure that may have reached the provider (a timeout, a
  // 5xx) is thrown as a PluginError with `outcomeUnknown`, and only a refusal in so many words says that nothing
  // was delivered.
  sendAlbum?(ctx: ChannelContext, params: SendAlbumParams): Promise<ChannelAlbumResult>

  // Optional, each one required by a declared capability (see the registry)
  sendTemplate?(ctx: ChannelContext, params: SendTemplateParams): Promise<ChannelMessageResult>
  listTemplates?(ctx: ChannelContext): Promise<MessageTemplate[]>
  sendButtons?(ctx: ChannelContext, params: SendButtonsParams): Promise<ChannelMessageResult>
  sendLocation?(ctx: ChannelContext, params: SendLocationParams): Promise<ChannelMessageResult>
  sendTypingIndicator?(ctx: ChannelContext, params: TypingParams): Promise<void>
  markAsRead?(ctx: ChannelContext, params: MarkReadParams): Promise<void>
  sendReaction?(ctx: ChannelContext, params: SendReactionParams): Promise<void>
  deleteMessage?(ctx: ChannelContext, params: DeleteMessageParams): Promise<void>
  editMessage?(ctx: ChannelContext, params: EditMessageParams): Promise<void>

  // GET handshake (Meta hub.challenge); null rejects it
  verifyWebhook?(query: Record<string, string>): string | null
  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean
  // Pure: normalizes and never fetches
  handleWebhook(payload: unknown): Promise<ChannelEvent[]>
  // Provider media needs the connection token
  fetchMedia?(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia>
  // Whether a link (a media ref that is not a plain id) is one this plugin would fetch. Pure: no network
  // and no lookup. The core asks it BEFORE it resolves the host of a link, so that a host the plugin would
  // refuse is never looked up from our servers (no probing through DNS, no retry of a link that can only
  // be refused). A plugin that has no such list leaves it out and only the public-address check applies.
  acceptsMediaLink?(mediaRef: string): boolean
  // Name, username and photo link of a customer, read with the connection token; null when the provider
  // has no profile for that person. Required by CUSTOMER_PROFILE. The core calls it from a job, never
  // from the webhook, and stores what it returns. Null is a final answer (nothing to read, now or on
  // the next try); a PluginError is a failure, retried when it says `retryable`. The core cuts every
  // field to its limit and keeps a photo link only if it is plain https, whatever the plugin sends.
  // `signal` aborts when the core stops waiting (its time for the read runs out): a plugin passes it to the
  // request it makes, so that the call to the provider ends instead of running on with nobody to hear it.
  fetchProfile?(
    ctx: ChannelContext,
    channelIdentity: string,
    signal?: AbortSignal
  ): Promise<ChannelCustomerProfile | null>
}
