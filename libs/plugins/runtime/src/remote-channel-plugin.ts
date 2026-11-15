import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import {
  CapabilityOfMediaKind,
  type ChannelMediaCapabilities,
  type ChannelMediaKind,
  ChannelMediaKinds,
  mediaKindOfContentType
} from '@platform/core/channel-media'
import {
  type ChannelCapabilityType,
  ChannelCapability,
  ChannelIdentityKinds,
  type ChannelLimits,
  DeliveryStatus,
  type LocalizedText,
  RemoteChannelCommands,
  type RemoteChannelCommand,
  RemoteChannelErrorCodes,
  RemoteChannelHeaders,
  RemoteChannelLimits,
  RemoteChannelSendTypes,
  type RemoteChannelSendType,
  RemoteTypingStates
} from '@platform/core/domain'
import { ErrorCodes, resourceConflict } from '@platform/core/errors'
import { UploadLimits } from '@platform/core/storage'
import {
  type PinnedExchangeOptions,
  type PinnedExchangeResult,
  pinnedHttpsExchange,
  pinnedHttpsGet,
  PinnedExchangeFailed,
  PinnedFetchFailed,
  PERMANENT_NETWORK_CODES,
  PinnedExchangeReasons,
  UnsafeUrlError
} from '@platform/core/url-safety'
import {
  type ChannelContext,
  type ChannelEvent,
  type ChannelHealth,
  type ChannelMessageResult,
  type ChannelPlugin,
  type ConnectField,
  type ConnectInput,
  type ConnectResult,
  type FetchedMedia,
  type MarkReadParams,
  type MessagingWindowPolicy,
  PluginError,
  type PluginErrorCode,
  PluginTypes,
  type SendMediaParams,
  type SendMessageParams,
  type TypingParams
} from '@platform/plugins/sdk'

import type { PluginManifest } from './plugin-manifest'
import { signRemoteCommand } from './remote-command-signature'

// The secrets that sign the commands of one installation. `previous` and `rotatedAt` are set after a rotation; the previous
// secret signs only while `ROTATION_GRACE_SECONDS` have not passed, and the adapter is the one that decides that.
export interface RemoteCommandSecrets {
  current: string
  previous: string | null
  rotatedAt: Date | null
}

// Where the adapter gets what is per store: the secrets of the installation of that store. `null` is "this store has no active
// installation of the plugin": nothing is sent. The adapter is the same object for every store; the store it asks for is the one
// of the context of the call, which the core took from a connection row, never from a request.
export interface RemoteSecretSource {
  secretsOf(storeId: string, pluginId: string): Promise<RemoteCommandSecrets | null>
  // The secrets for telling a plugin that a connection was disconnected: the owner uninstalls, the installation is revoked first, and
  // the plugin must still hear it. Never used for any other command.
  secretsForDisconnect(storeId: string, pluginId: string): Promise<RemoteCommandSecrets | null>
}

export type RemoteExchange = (
  url: string,
  options: PinnedExchangeOptions
) => Promise<PinnedExchangeResult>

export type RemoteFileGet = typeof pinnedHttpsGet

export interface RemoteChannelDeps {
  secrets: RemoteSecretSource
  // The GET of a file the customer sent (§6.7.6); replaceable for the same reason
  get?: RemoteFileGet
  // Replaceable so that a unit spec needs no network. The default resolves the address at every call, accepts only a public one
  // and connects to the address it checked (a host that changes its answer later is not followed).
  exchange?: RemoteExchange
  now?: () => number
  deliveryId?: () => string
}

// Only the platform's own words, never what the plugin said: a plugin is a third party's and its text could carry anything
const sendAnswer = z.object({
  externalId: z.string().min(1).max(512),
  status: z.literal(DeliveryStatus.SENT),
  sentAt: z.iso.datetime({ offset: true }).optional()
})
const healthAnswer = z.object({ healthy: z.boolean(), error: z.string().max(2000).optional() })
const refusalAnswer = z.object({
  error: z.object({
    code: z.string().max(64),
    message: z.string().max(2000).optional(),
    retryable: z.boolean().optional()
  })
})

const LIMITS: ChannelLimits = { textMaxLength: RemoteChannelLimits.TEXT_MAX_LENGTH }

const SEND_TYPE_OF_KIND: Readonly<Record<ChannelMediaKind, RemoteChannelSendType>> = {
  [ChannelMediaKinds.IMAGE]: RemoteChannelSendTypes.IMAGE,
  [ChannelMediaKinds.VIDEO]: RemoteChannelSendTypes.VIDEO,
  [ChannelMediaKinds.AUDIO]: RemoteChannelSendTypes.AUDIO,
  [ChannelMediaKinds.DOCUMENT]: RemoteChannelSendTypes.DOCUMENT
}

// Failures of the connection before a byte of the request left: the plugin is down or unreachable, and it heard nothing
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH'
])

interface CommandOptions {
  idempotencyKey?: string
  timeoutMs: number
  // A send that gets no clear answer may have gone out: the error says so. Best-effort commands have nothing to say about it.
  changesProvider: boolean
  // Only the disconnect: signed with the secrets of an installation that is being revoked
  teardown?: boolean
}

// The adapter of TDD_10 §6.7: a `ChannelPlugin` that talks HTTP to a service outside the platform. The rest of the platform
// (the outbound queue, the health round, the typing and read hooks, the window) treats it as it treats an official plugin.
// It holds nothing of a store: the secrets come from the installation of `ctx.storeId`, and the credentials of the provider
// stay in the plugin, so `ctx.credentials` is never sent.
export class RemoteChannelPlugin implements ChannelPlugin {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly author: string
  readonly type = PluginTypes.CHANNEL
  readonly capabilities: readonly ChannelCapabilityType[]
  readonly limits = LIMITS
  readonly identityKind = ChannelIdentityKinds.OPAQUE
  readonly displayName: LocalizedText
  readonly messagingWindow: MessagingWindowPolicy | null
  readonly connectFields: readonly ConnectField[]
  readonly receivesProviderWebhooks = false
  readonly media?: ChannelMediaCapabilities
  // Present only when the manifest declared the capability (the registry checks both ways)
  readonly sendTypingIndicator?: (ctx: ChannelContext, params: TypingParams) => Promise<void>
  readonly markAsRead?: (ctx: ChannelContext, params: MarkReadParams) => Promise<void>

  private readonly commandsUrl: string
  // Where the owner links an account of the provider (the `ui.settings` of the manifest), or null
  readonly settingsUrl: string | null
  private readonly secrets: RemoteSecretSource
  private readonly exchange: RemoteExchange
  private readonly get: RemoteFileGet
  private readonly now: () => number
  private readonly deliveryId: () => string

  constructor(manifest: PluginManifest, deps: RemoteChannelDeps) {
    const channel = manifest.channel
    if (channel === undefined)
      throw new Error('the manifest of a remote channel has no channel block')
    this.id = manifest.id
    this.name = manifest.name
    this.version = manifest.version
    this.author = manifest.author.name
    // Copied: what the manifest declares later does not change what this adapter does
    this.capabilities = Object.freeze([...(manifest.capabilities ?? [])] as ChannelCapabilityType[])
    this.displayName = Object.freeze({ es: channel.label, en: channel.label })
    this.messagingWindow =
      channel.messagingWindow === undefined
        ? null
        : Object.freeze({ hours: channel.messagingWindow.hours, requiresTemplateWhenClosed: false })
    this.connectFields = Object.freeze(
      (channel.connectFields ?? []).map(field =>
        Object.freeze({
          key: field.key,
          label: { es: field.label.es, en: field.label.en },
          secret: field.secret,
          required: field.required,
          multiple: field.multiple
        })
      )
    )
    this.commandsUrl = channel.commandsUrl
    this.settingsUrl = manifest.ui?.settings ?? null
    this.secrets = deps.secrets
    this.exchange = deps.exchange ?? pinnedHttpsExchange
    this.get = deps.get ?? pinnedHttpsGet
    this.now = deps.now ?? Date.now
    this.deliveryId = deps.deliveryId ?? randomUUID

    const kinds: Partial<Record<ChannelMediaKind, { types: null; maxBytes: number }>> = {}
    for (const kind of Object.values(ChannelMediaKinds)) {
      if (this.capabilities.includes(CapabilityOfMediaKind[kind])) {
        // The types the platform lets be uploaded are the only filter, as for a provider that publishes no list
        kinds[kind] = { types: null, maxBytes: UploadLimits.MAX_FILE_SIZE_BYTES }
      }
    }
    if (Object.keys(kinds).length > 0) {
      this.media = {
        maxFilesPerMessage: RemoteChannelLimits.MAX_FILES_PER_MESSAGE,
        kinds
      }
    }
    if (this.capabilities.includes(ChannelCapability.TYPING_INDICATOR)) {
      this.sendTypingIndicator = (ctx, params) => this.typing(ctx, params)
    }
    if (this.capabilities.includes(ChannelCapability.READ_RECEIPTS)) {
      this.markAsRead = (ctx, params) => this.markRead(ctx, params)
    }
  }

  // The connection is made in the plugin (its settings page: a QR to scan, a login), which then registers it through the API
  // (§6.7.5). The platform never sees what was entered there, so there is nothing to connect from here.
  connect(_input: ConnectInput): Promise<ConnectResult> {
    return Promise.reject(
      resourceConflict('this channel is connected in its own settings page', {
        settingsUrl: this.settingsUrl
      })
    )
  }

  // Best effort, never retried: the owner disconnected it here, and a plugin that is down must not keep it connected
  async disconnect(ctx: ChannelContext): Promise<void> {
    try {
      await this.command(
        ctx,
        RemoteChannelCommands.CONNECTION_DISCONNECT,
        {},
        {
          timeoutMs: RemoteChannelLimits.COMMAND_TIMEOUT_MS,
          changesProvider: false,
          teardown: true
        }
      )
    } catch {
      // Nothing to tell anybody: the connection is disconnected on the platform either way
    }
  }

  async healthCheck(ctx: ChannelContext): Promise<ChannelHealth> {
    const answer = await this.command(
      ctx,
      RemoteChannelCommands.CONNECTION_HEALTH,
      {},
      {
        timeoutMs: RemoteChannelLimits.COMMAND_TIMEOUT_MS,
        changesProvider: false
      }
    )
    const report = healthAnswer.safeParse(answer)
    if (!report.success) throw this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
    // The time of the check is the platform's
    const checkedAt = new Date(this.now()).toISOString()
    return report.data.healthy
      ? { healthy: true, checkedAt }
      : {
          healthy: false,
          checkedAt,
          ...(report.data.error === undefined ? {} : { error: report.data.error })
        }
  }

  async sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    return this.send(ctx, params.idempotencyKey, {
      messageId: params.idempotencyKey,
      channelIdentity: params.channelIdentity,
      type: RemoteChannelSendTypes.TEXT,
      content: params.content,
      ...(params.replyToExternalId === undefined
        ? {}
        : { replyToExternalId: params.replyToExternalId })
    })
  }

  async sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult> {
    // The plugin gets an address, never the bytes; a caller with no storage to sign for cannot send to a remote plugin
    if (params.signedUrl === undefined) {
      throw this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, refused: true })
    }
    const contentType = params.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
    const url = await params.signedUrl(RemoteChannelLimits.MEDIA_URL_TTL_SECONDS)
    return this.send(ctx, params.idempotencyKey, {
      messageId: params.idempotencyKey,
      channelIdentity: params.channelIdentity,
      type: SEND_TYPE_OF_KIND[mediaKindOfContentType(contentType)],
      ...(params.caption === undefined ? {} : { content: params.caption }),
      ...(params.replyToExternalId === undefined
        ? {}
        : { replyToExternalId: params.replyToExternalId }),
      media: { url, contentType, filename: params.filename }
    })
  }

  // Never used for a remote plugin: its events arrive at `POST /events` already normalised (§6.7.4)
  validateWebhookSignature(): boolean {
    return false
  }

  handleWebhook(): Promise<ChannelEvent[]> {
    return Promise.resolve([])
  }

  private async typing(ctx: ChannelContext, params: TypingParams): Promise<void> {
    await this.command(
      ctx,
      RemoteChannelCommands.TYPING_SEND,
      {
        channelIdentity: params.channelIdentity,
        state: params.active ? RemoteTypingStates.START : RemoteTypingStates.STOP
      },
      { timeoutMs: RemoteChannelLimits.BEST_EFFORT_TIMEOUT_MS, changesProvider: false }
    )
  }

  private async markRead(ctx: ChannelContext, params: MarkReadParams): Promise<void> {
    await this.command(
      ctx,
      RemoteChannelCommands.MESSAGE_MARK_READ,
      { channelIdentity: params.channelIdentity, externalId: params.externalId },
      { timeoutMs: RemoteChannelLimits.BEST_EFFORT_TIMEOUT_MS, changesProvider: false }
    )
  }

  private async send(
    ctx: ChannelContext,
    idempotencyKey: string,
    data: Record<string, unknown>
  ): Promise<ChannelMessageResult> {
    const answer = await this.command(ctx, RemoteChannelCommands.MESSAGE_SEND, data, {
      idempotencyKey,
      timeoutMs: RemoteChannelLimits.COMMAND_TIMEOUT_MS,
      changesProvider: true
    })
    const parsed = sendAnswer.safeParse(answer)
    // The plugin answered 200 with something the table does not describe: sending again could send twice
    if (!parsed.success) {
      throw this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
        retryable: false,
        outcomeUnknown: true
      })
    }
    return {
      externalId: parsed.data.externalId,
      status: DeliveryStatus.SENT,
      sentAt: parsed.data.sentAt ?? new Date(this.now()).toISOString()
    }
  }

  // The file a customer sent a remote plugin (§6.7.6): the address is a public https one that the plugin put in its event, so it is
  // judged again here, now: resolved, every address public, and the one connection made to the address that was checked. No redirect
  // is followed (a 3xx is a failure) and the wait is 30 seconds. The caller keeps to the size and type limits of a message's media
  // and scans what it stores. The signature of the commands (over an empty body) goes only to the host of `commandsUrl`, so a plugin
  // can keep its own file addresses private and a third-party host never gets a valid signature.
  async fetchMedia(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia> {
    let sameHost = false
    try {
      sameHost = new URL(mediaRef).host === new URL(this.commandsUrl).host
    } catch {
      // Not an address: the fetch below refuses it as unsafe
    }
    const headers: Record<string, string> = {}
    if (sameHost) {
      const secrets = await this.secrets.secretsOf(ctx.storeId, this.id)
      if (secrets === null) {
        throw this.failure(ErrorCodes.CHANNEL_NOT_CONNECTED, { retryable: false, refused: true })
      }
      const nowMs = this.now()
      headers[RemoteChannelHeaders.SIGNATURE] = signRemoteCommand(
        '',
        this.activeSecrets(secrets, nowMs),
        Math.floor(nowMs / 1000)
      )
    }
    try {
      const file = await this.get(mediaRef, {
        accept: '*/*',
        timeoutMs: RemoteChannelLimits.MEDIA_FETCH_TIMEOUT_MS,
        headers
      })
      return {
        stream: file.stream,
        contentType: file.contentType,
        contentLength: file.contentLength
      }
    } catch (error) {
      // The caller marks an unsafe address as such, and does not try it again
      if (error instanceof UnsafeUrlError) throw error
      // What the file server said is its own: only whether trying again may help. Anything else is ours (a bug, a store that
      // failed) and goes up as what it is, not as a failure of a message
      if (error instanceof PinnedFetchFailed) {
        throw this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: error.retryable })
      }
      throw error
    }
  }

  // One signed POST. The store of the command is the one of the context; the address is resolved and checked now, at every call.
  private async command(
    ctx: ChannelContext,
    command: RemoteChannelCommand,
    data: Record<string, unknown>,
    options: CommandOptions
  ): Promise<unknown> {
    const secrets =
      options.teardown === true
        ? await this.secrets.secretsForDisconnect(ctx.storeId, this.id)
        : await this.secrets.secretsOf(ctx.storeId, this.id)
    // No active installation of this store: nothing is sent, and what was queued for it fails for good
    if (secrets === null) {
      throw this.failure(ErrorCodes.CHANNEL_NOT_CONNECTED, { retryable: false, refused: true })
    }
    const body = JSON.stringify({
      command,
      storeId: ctx.storeId,
      connectionId: ctx.connectionId,
      data
    })
    if (Buffer.byteLength(body, 'utf8') > RemoteChannelLimits.MAX_REQUEST_BYTES) {
      throw this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, refused: true })
    }
    const nowMs = this.now()
    const signature = signRemoteCommand(
      body,
      this.activeSecrets(secrets, nowMs),
      Math.floor(nowMs / 1000)
    )
    let result: PinnedExchangeResult
    try {
      result = await this.exchange(this.commandsUrl, {
        body,
        headers: {
          'content-type': 'application/json',
          [RemoteChannelHeaders.SIGNATURE]: signature,
          [RemoteChannelHeaders.DELIVERY]: this.deliveryId(),
          ...(options.idempotencyKey === undefined
            ? {}
            : { [RemoteChannelHeaders.IDEMPOTENCY_KEY]: options.idempotencyKey })
        },
        timeoutMs: options.timeoutMs,
        maxResponseBytes: RemoteChannelLimits.MAX_RESPONSE_BYTES,
        // The status and the body of a refusal are the plugin's answer to map (§6.7.4)
        anyStatus: true
      })
    } catch (error) {
      throw this.transportFailure(error, options)
    }
    return this.read(result, options)
  }

  private activeSecrets(secrets: RemoteCommandSecrets, nowMs: number): string[] {
    const open =
      secrets.previous !== null &&
      secrets.rotatedAt !== null &&
      nowMs - secrets.rotatedAt.getTime() <= RemoteChannelLimits.ROTATION_GRACE_SECONDS * 1000
    return open && secrets.previous !== null
      ? [secrets.current, secrets.previous]
      : [secrets.current]
  }

  private read(result: PinnedExchangeResult, options: CommandOptions): unknown {
    const { status } = result
    if (status >= 200 && status < 300) {
      if (result.body.trim() === '') return {}
      try {
        return JSON.parse(result.body) as unknown
      } catch {
        throw this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
          retryable: false,
          outcomeUnknown: options.changesProvider
        })
      }
    }
    throw this.refusalOf(status, result.body, options)
  }

  // What a status that is not a success says, with the body when it could be read: the plugin's code and `retryable`, or the status alone
  private refusalOf(status: number, body: string, options: CommandOptions): PluginError {
    // Not followed: the address of a redirect is one nobody has checked
    if (status >= 300 && status < 400) {
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, refused: true })
    }
    let said: z.output<typeof refusalAnswer>['error'] | null = null
    try {
      const parsed = refusalAnswer.safeParse(JSON.parse(body))
      if (parsed.success) said = parsed.data.error
    } catch {
      // Not JSON: the status alone decides
    }
    const serverSide = status >= 500
    const retryable = said?.retryable ?? (status === 429 || serverSide)
    return this.failure(this.codeOf(said?.code), {
      retryable,
      // A 5xx may have done the work before it failed; a 4xx is the plugin saying it did not take the request
      ...(serverSide && options.changesProvider ? { outcomeUnknown: true } : { refused: true })
    })
  }

  private codeOf(code: string | undefined): PluginErrorCode {
    if (code === RemoteChannelErrorCodes.WINDOW_CLOSED) return ErrorCodes.CHANNEL_WINDOW_EXPIRED
    if (code === RemoteChannelErrorCodes.NOT_CONNECTED) return ErrorCodes.CHANNEL_NOT_CONNECTED
    return ErrorCodes.CHANNEL_MESSAGE_FAILED
  }

  private transportFailure(error: unknown, options: CommandOptions): PluginError {
    // The address does not lead to the public internet: nothing was sent, and the next try would be the same
    if (error instanceof UnsafeUrlError) {
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, refused: true })
    }
    const reason = error instanceof PinnedExchangeFailed ? error.reason : ''
    const [kind, networkCode = ''] = reason.split(':')
    // A certificate that does not fit, or a name that does not exist: asking again changes nothing, and nothing reached the plugin
    if (PERMANENT_NETWORK_CODES.has(networkCode)) {
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, refused: true })
    }
    // The name did not resolve, or the request could not be made: nothing reached the plugin
    if (kind === PinnedExchangeReasons.NOT_RESOLVED) {
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
    }
    if (kind === PinnedExchangeReasons.REQUEST_REFUSED) {
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, refused: true })
    }
    // An answer longer than the ceiling was aborted. With a status of refusal (a gateway's page) it is a refusal, mapped as a
    // refusal is; with a 2xx the plugin did what it did, and asking again changes nothing.
    if (kind === PinnedExchangeReasons.TOO_LARGE) {
      const status = error instanceof PinnedExchangeFailed ? (error.status ?? 0) : 0
      if (status >= 300) return this.refusalOf(status, '', options)
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
        retryable: false,
        outcomeUnknown: options.changesProvider
      })
    }
    // Nobody answered before the connection was made: nothing was sent
    if (kind === PinnedExchangeReasons.NO_ANSWER && CONNECT_PHASE_CODES.has(networkCode)) {
      return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
    }
    // A timeout, a connection that dropped: the plugin may have taken the message
    return this.failure(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
      retryable: true,
      outcomeUnknown: options.changesProvider
    })
  }

  private failure(
    code: PluginErrorCode,
    options: { retryable: boolean; refused?: boolean; outcomeUnknown?: boolean }
  ): PluginError {
    return new PluginError(code, options)
  }
}
