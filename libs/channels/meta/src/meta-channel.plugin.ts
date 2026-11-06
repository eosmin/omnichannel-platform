import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import {
  CaptionState,
  ChannelResultMetadata,
  DeliveryStatus,
  isPlainHttpsUrl,
  type MetaGraphOrigin,
  MetaMessaging,
  MetaSubscription,
  type MetaWebhookApp
} from '@platform/core/domain'
import { ErrorCodes, PluginChecks } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelCapabilityType,
  type ChannelContext,
  type ChannelCustomerProfile,
  type ChannelEvent,
  type ChannelHealth,
  type ChannelMessageResult,
  type ChannelOAuth,
  type ChannelPlugin,
  type ConnectField,
  type ConnectInput,
  type ConnectResult,
  type FetchedMedia,
  PluginError,
  type MarkReadParams,
  PluginTypes,
  type SendMediaParams,
  type SendMessageParams,
  type SendReactionParams,
  type TypingParams
} from '@platform/plugins/sdk'

import { MetaGraphClient } from './meta-graph.client'
import { MetaLogin } from './meta-login'
import { messagingToEvents } from './meta-messaging-events'
import { mergeSubscribedFields, readSubscribedFields } from './meta-subscription'
import { parseMetaTokenCredentials } from './meta-token-credentials'
import { withCheck } from './with-check'

const MESSAGING_WINDOW_HOURS = 24
// Meta: up to 7 days from the first message after a Click-to-Message ad (changelog of 2026-09-28)
const AD_WINDOW_HOURS = 168

const successSchema = z.object({ success: z.boolean() })
const appIdSchema = z.object({ id: z.string() })
// The Send API answers with the ids of the recipient and the message
const sentSchema = z.object({ message_id: z.string().min(1) })
// What the User Profile API of either host answers; a person who keeps it private gets an empty object
const userProfileSchema = z.object({
  name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  username: z.string().nullish(),
  profile_pic: z.string().nullish()
})
// A reaction is answered with the recipient only, and nobody reads it again
const acknowledgedSchema = z.record(z.string(), z.unknown())

export interface MetaAccount {
  // The Page or the Instagram account that receives the webhooks: `entry.id`
  id: string
  displayName: string
  // What the connection keeps beside its id (the Instagram connection keeps its Page)
  metadata?: Record<string, unknown>
}

// The Graph API messaging that Instagram and Messenger share: one webhook shape and one Send API on
// two hosts. A subclass says its host, its webhook object, how to read its own account and the few
// places where the two differ. It holds no state and reads no environment: the connection's token
// arrives with every call, and the platform's Meta app (signature and handshake) is behind
// MetaGraphClient.
//
// Meta has no idempotency key, so `idempotencyKey` is not used; the client never repeats a send that
// may already have gone out.
@Injectable()
export abstract class MetaChannelPlugin implements ChannelPlugin {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: readonly ChannelCapabilityType[]
  // One token names the account (see metaTokenCredentialsSchema); each channel words its label
  abstract readonly connectFields: readonly ConnectField[]
  readonly receivesProviderWebhooks = true
  readonly version = '1.0.0'
  readonly author = 'Platform Team'
  readonly type = PluginTypes.CHANNEL
  // Meta policy: reply within 24 h of the last customer message, 7 days after an ad; no templates
  readonly messagingWindow = {
    hours: MESSAGING_WINDOW_HOURS,
    requiresTemplateWhenClosed: false,
    extendedHoursAfterAd: AD_WINDOW_HOURS
  }

  // The Meta app that signs this channel's webhooks; every channel says it (see MetaWebhookApps)
  protected abstract readonly webhookApp: MetaWebhookApp
  protected abstract readonly origin: MetaGraphOrigin
  protected abstract readonly webhookObject: string
  protected abstract readonly subscribedFields: string
  // The key that holds the file of a media message in the Send API
  protected abstract readonly attachmentKey: string
  // The `fields` of the User Profile API on this host
  protected abstract readonly userProfileFields: string

  constructor(protected readonly meta: MetaGraphClient) {}

  // "Connect with Facebook" (Step 7.8). A getter, because `id` belongs to the subclass and is not set while the
  // base is built; the registry reads it once.
  private login: MetaLogin | undefined
  get oauth(): ChannelOAuth {
    this.login ??= new MetaLogin(this.id, this.meta)
    return this.login
  }

  // Who the token belongs to, read from Meta with that token. `expectedId` is the account a connection
  // already has, for a plugin whose token can reach more than one (it answers with that one); a plugin
  // whose token is of a single account ignores it, and the health check compares the id afterwards.
  protected abstract fetchAccount(token: string, expectedId?: string): Promise<MetaAccount>

  // The node of the paths that belong to the token and not to the account's id: where the app is
  // subscribed and where a message is sent. By default the id of the connection.
  protected subscribeOwner(account: MetaAccount): string {
    return account.id
  }

  protected sendOwner(ctx: ChannelContext): string {
    return ctx.connectionId
  }

  // What the health check reads: by default only the id (a subclass whose name costs a call or a
  // permission reads the id alone); a subclass that keeps more than the id of the account returns it
  protected async fetchHealthAccount(
    token: string,
    ctx: ChannelContext
  ): Promise<Pick<MetaAccount, 'id' | 'metadata'>> {
    return { id: await this.fetchAccountId(token, ctx.connectionId) }
  }

  // A check beyond the id of the account, thrown as a PluginError; none by default
  protected verifyBinding(
    _account: Pick<MetaAccount, 'id' | 'metadata'>,
    _ctx: ChannelContext
  ): void {
    // The id of the account is the whole binding
  }

  // Fields of every send that only one of the two APIs wants
  protected sendFields(): Record<string, unknown> {
    return {}
  }

  // Where a reply to a message goes in the Send API
  protected replyFields(replyToExternalId: string | undefined): Record<string, unknown> {
    return replyToExternalId === undefined ? {} : { reply_to: { mid: replyToExternalId } }
  }

  // Only the id of the account, for a check that has no use for its name; a subclass whose name costs a
  // call or a permission reads the id alone
  protected async fetchAccountId(token: string, expectedId?: string): Promise<string> {
    return (await this.fetchAccount(token, expectedId)).id
  }

  // The id goes into the path of every call after this one: digits only, whoever the subclass is
  private checkedId(id: string): string {
    if (!MetaMessaging.RECIPIENT_ID_PATTERN.test(id)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.ACCOUNT_ID_NOT_NUMERIC
      })
    }
    return id
  }

  private async readAccount(token: string): Promise<MetaAccount> {
    let account: MetaAccount
    try {
      account = await this.fetchAccount(token)
    } catch (error) {
      // Which call failed, for the log: a check the plugin already named stays
      throw withCheck(error, PluginChecks.ACCOUNT_READ_FAILED)
    }
    this.checkedId(account.id)
    return account
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const { accessToken } = parseMetaTokenCredentials(input.credentials)
    const account = await this.readAccount(accessToken)
    const owner = this.subscribeOwner(account)
    // Messenger and Instagram share the Page and the app, and the fields of the app on the Page are one
    // list: this channel's fields are added to the ones the app already has, never posted over them
    const fields = await this.fieldsToSubscribe(owner, accessToken)
    // Webhooks only reach the app for an account that subscribed it. This also proves that the token
    // can act on the account it names.
    const subscribed = await this.meta
      .post({
        origin: this.origin,
        path: [owner, MetaMessaging.EDGE_SUBSCRIBED_APPS],
        token: accessToken,
        query: { subscribed_fields: fields },
        idempotent: true,
        schema: successSchema
      })
      .catch((error: unknown) => {
        throw withCheck(error, PluginChecks.SUBSCRIBE_FAILED)
      })
    if (!subscribed.success) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED
      })
    }
    return {
      connectionId: account.id,
      displayName: account.displayName,
      credentials: { accessToken },
      metadata: account.metadata ?? {}
    }
  }

  // What the app has on the node plus what this channel asks for. Nothing is subscribed blind: if the
  // app of the token cannot be told, or what it has cannot be read, the connection is refused with the
  // check that failed (and whether it may be tried again, which is the provider's word).
  private async fieldsToSubscribe(owner: string, token: string): Promise<string> {
    const appId = await this.appIdOf(token)
    let answer: unknown
    try {
      answer = await this.meta.get({
        origin: this.origin,
        path: [owner, MetaMessaging.EDGE_SUBSCRIBED_APPS],
        token,
        schema: z.unknown()
      })
    } catch (error) {
      throw withCheck(error, PluginChecks.SUBSCRIPTION_READ_FAILED)
    }
    const current = readSubscribedFields(answer, appId)
    if (current === null) {
      throw new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
        retryable: false,
        failedCheck: PluginChecks.SUBSCRIPTION_SHAPE_INVALID
      })
    }
    return mergeSubscribedFields(current, this.subscribedFields)
  }

  // The app the token belongs to (`GET app?fields=id`), to pick its entry among the apps of the node. If
  // Meta does not answer it for a token like this one, the connection is refused rather than guessing
  // which entry is ours (IMPLEMENTATION_PLAN, Step 7.3: `META_APP_ID` is the fallback to add then).
  private async appIdOf(token: string): Promise<string> {
    try {
      const { id } = await this.meta.get({
        origin: this.origin,
        path: [MetaSubscription.APP_EDGE],
        token,
        query: { fields: MetaSubscription.APP_ID_FIELD },
        schema: appIdSchema
      })
      if (!MetaSubscription.APP_ID_PATTERN.test(id)) {
        throw new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
      }
      return id
    } catch (error) {
      throw withCheck(error, PluginChecks.SUBSCRIPTION_APP_UNKNOWN)
    }
  }

  // The subscription belongs to the account and a disconnected connection needs nothing from Meta:
  // the core drops the webhooks of a connection it does not have
  async disconnect(): Promise<void> {
    return Promise.resolve()
  }

  // A failure is thrown, not reported: the health service reads a PluginError as the state of the
  // connection (a revoked token is not a Meta outage)
  async healthCheck(ctx: ChannelContext): Promise<ChannelHealth> {
    const account = await this.fetchHealthAccount(
      parseMetaTokenCredentials(ctx.credentials).accessToken,
      ctx
    )
    const id = this.checkedId(account.id)
    // A token of another account would read well and send under the wrong one
    if (id !== ctx.connectionId) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.ACCOUNT_ID_MISMATCH
      })
    }
    this.verifyBinding(account, ctx)
    return { healthy: true, checkedAt: new Date().toISOString() }
  }

  async sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    return this.send(ctx, params.channelIdentity, {
      message: { text: params.content },
      ...this.replyFields(params.replyToExternalId)
    })
  }

  // Meta takes a file and no caption, so the caption is a message of its own after the file. Meta echoes
  // that second message too, so its id travels in `metadata[ChannelResultMetadata.CAPTION_EXTERNAL_ID]`: whoever deduplicates
  // the echoes has to know it. If the second call fails the file is already with the customer: the answer
  // is the file's, carrying a `CAPTION_STATE`, so that the id of the file is kept (its echo is not stored as
  // the owner's) and the message is not sent again, which would send the file twice.
  async sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult> {
    // Meta fetches the file itself, and only over https; a url with a user or a password would hand
    // them to Meta. And a kind of file the channel does not declare is refused here, not left to Meta.
    const kind = attachmentKind(params.contentType)
    if (!this.capabilities.includes(kind.capability)) {
      throw new PluginError(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, { retryable: false })
    }
    if (!isPlainHttpsUrl(params.mediaUrl)) {
      throw new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
    }
    const sent = await this.send(ctx, params.channelIdentity, {
      message: {
        [this.attachmentKey]: {
          type: kind.type,
          payload: { url: params.mediaUrl }
        }
      },
      ...this.replyFields(params.replyToExternalId)
    })
    if (!params.caption) return sent
    try {
      const caption = await this.send(ctx, params.channelIdentity, {
        message: { text: params.caption }
      })
      return {
        ...sent,
        metadata: { [ChannelResultMetadata.CAPTION_EXTERNAL_ID]: caption.externalId }
      }
    } catch (error) {
      // Meta has no idempotency key on the Send API, so a second call cannot be made safe. What can be
      // told is whether the first one may have gone out: a refusal did not, a timeout or a 5xx may have.
      // Only the first is a failure; the other waits for the echo (`CaptionState.UNCONFIRMED`).
      const refused = error instanceof PluginError && !error.outcomeUnknown
      return {
        ...sent,
        metadata: {
          [ChannelResultMetadata.CAPTION_STATE]: refused
            ? CaptionState.FAILED
            : CaptionState.UNCONFIRMED
        }
      }
    }
  }

  async sendReaction(ctx: ChannelContext, params: SendReactionParams): Promise<void> {
    const { accessToken } = parseMetaTokenCredentials(ctx.credentials)
    // The same reaction twice is the same reaction: the call is safe to repeat
    await this.meta.post({
      origin: this.origin,
      path: [this.sendOwner(ctx), MetaMessaging.EDGE_MESSAGES],
      token: accessToken,
      body: {
        recipient: { id: params.channelIdentity },
        sender_action:
          params.emoji === null ? MetaMessaging.ACTION_UNREACT : MetaMessaging.ACTION_REACT,
        payload: {
          message_id: params.targetExternalId,
          ...(params.emoji === null ? {} : { reaction: params.emoji })
        }
      },
      idempotent: true,
      schema: acknowledgedSchema
    })
  }

  // Meta shows `typing_on` for about twenty seconds and takes it away with `typing_off`
  async sendTypingIndicator(ctx: ChannelContext, params: TypingParams): Promise<void> {
    await this.senderAction(
      ctx,
      params.channelIdentity,
      params.active ? MetaMessaging.ACTION_TYPING_ON : MetaMessaging.ACTION_TYPING_OFF
    )
  }

  // `mark_seen` marks the whole conversation up to its latest message, so the message id is not used
  async markAsRead(ctx: ChannelContext, params: MarkReadParams): Promise<void> {
    await this.senderAction(ctx, params.channelIdentity, MetaMessaging.ACTION_MARK_SEEN)
  }

  // The id goes into the path, so it must be digits. A person with no readable profile (blocked us, an
  // account made with a phone number, a feature the app has not been approved for) is null, not an
  // error: asking again would answer the same.
  async fetchProfile(
    ctx: ChannelContext,
    channelIdentity: string
  ): Promise<ChannelCustomerProfile | null> {
    if (!MetaMessaging.RECIPIENT_ID_PATTERN.test(channelIdentity)) return null
    const { accessToken } = parseMetaTokenCredentials(ctx.credentials)
    try {
      const raw = await this.meta.get({
        origin: this.origin,
        path: [channelIdentity],
        token: accessToken,
        query: { fields: this.userProfileFields },
        schema: userProfileSchema
      })
      const name =
        present(raw.name) ??
        present(
          [present(raw.first_name), present(raw.last_name)]
            .filter((part): part is string => part !== undefined)
            .join(' ')
        )
      const username = present(raw.username)
      // A link that is not plain https is no photo: it must not keep an empty profile from being null
      const link = present(raw.profile_pic)
      const avatarUrl = link !== undefined && isPlainHttpsUrl(link) ? link : undefined
      if (name === undefined && username === undefined && avatarUrl === undefined) return null
      return {
        ...(name === undefined ? {} : { name }),
        ...(username === undefined ? {} : { username }),
        ...(avatarUrl === undefined ? {} : { avatarUrl })
      }
    } catch (error) {
      if (error instanceof PluginError && error.code === ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE) {
        return null
      }
      throw error
    }
  }

  verifyWebhook(query: Record<string, string>): string | null {
    return this.meta.verifyHubChallenge(query)
  }

  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    return this.meta.isValidSignature(rawBody, headers, this.webhookApp)
  }

  async handleWebhook(payload: unknown): Promise<ChannelEvent[]> {
    return Promise.resolve(messagingToEvents(payload, this.webhookObject))
  }

  // The reference of a file is the url Meta put in the webhook, a link of its CDN
  async fetchMedia(_ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia> {
    return this.meta.downloadMediaUrl(mediaRef)
  }

  // A sender action goes alone: Meta refuses it together with the fields of a message. Repeating one
  // changes nothing, so the call is safe to repeat.
  private async senderAction(
    ctx: ChannelContext,
    recipientId: string,
    action: string
  ): Promise<void> {
    const { accessToken } = parseMetaTokenCredentials(ctx.credentials)
    await this.meta.post({
      origin: this.origin,
      path: [this.sendOwner(ctx), MetaMessaging.EDGE_MESSAGES],
      token: accessToken,
      body: { recipient: { id: recipientId }, sender_action: action },
      idempotent: true,
      schema: acknowledgedSchema
    })
  }

  private async send(
    ctx: ChannelContext,
    recipientId: string,
    body: Record<string, unknown>
  ): Promise<ChannelMessageResult> {
    const { accessToken } = parseMetaTokenCredentials(ctx.credentials)
    const response = await this.meta.post({
      origin: this.origin,
      path: [this.sendOwner(ctx), MetaMessaging.EDGE_MESSAGES],
      token: accessToken,
      body: { recipient: { id: recipientId }, ...this.sendFields(), ...body },
      schema: sentSchema
    })
    return {
      externalId: response.message_id,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString()
    }
  }
}

// The kind of file the Send API wants, from its content type, and the capability that allows it;
// anything else goes as a file
function attachmentKind(contentType: string): { type: string; capability: ChannelCapabilityType } {
  if (contentType.startsWith('image/')) {
    return { type: MetaMessaging.ATTACHMENT_IMAGE, capability: ChannelCapability.IMAGE }
  }
  if (contentType.startsWith('video/')) {
    return { type: MetaMessaging.ATTACHMENT_VIDEO, capability: ChannelCapability.VIDEO }
  }
  if (contentType.startsWith('audio/')) {
    return { type: MetaMessaging.ATTACHMENT_AUDIO, capability: ChannelCapability.AUDIO }
  }
  return { type: MetaMessaging.ATTACHMENT_FILE, capability: ChannelCapability.DOCUMENT }
}

function present(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}
