import {
  type ChannelConnectFailureReason,
  connectReasonOfCheck,
  isChannelConnectFailureReason,
  type ErrorCode,
  type ErrorCodes,
  isPluginCheck,
  type PluginCheck,
  PlatformException
} from '@platform/core/errors'

// The codes a plugin may raise: what a provider can do wrong, never a platform error
export type PluginErrorCode = Extract<
  ErrorCode,
  | typeof ErrorCodes.CHANNEL_MESSAGE_FAILED
  | typeof ErrorCodes.CHANNEL_CREDENTIALS_INVALID
  | typeof ErrorCodes.CHANNEL_FEATURE_NOT_PERMITTED
  | typeof ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED
  | typeof ErrorCodes.CHANNEL_WINDOW_EXPIRED
  | typeof ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
  | typeof ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED
  | typeof ErrorCodes.CHANNEL_FILE_TOO_LARGE
  | typeof ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE
  | typeof ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID
  | typeof ErrorCodes.RATE_LIMIT_EXCEEDED
>

// How a channel plugin reports a failure. It carries the code and nothing the provider said: the
// message and the metadata of a PlatformException reach the client and the logs as they are, and a
// provider's error body can echo the token it was called with. The core decides the answer from
// the code alone.
export class PluginError extends PlatformException {
  // What the plugin says about trying again: true after a 429 or a 5xx of the provider, false when
  // it will not change. It wins over any guess the core makes (TDD_10 §6.7.4); left out, the core
  // does not try again.
  readonly retryable: boolean | undefined
  // True when the call changes something at the provider and got no clear answer (a timeout, a 5xx, an
  // unreadable 2xx): the provider may have done the work. False or left out: it did not. A send that fails
  // without this flag is still not taken for a refusal (see `refused`): the agent can send it again, not throw it away.
  readonly outcomeUnknown: boolean
  // True when the provider ANSWERED that it did not take the request (a refusal, a throttle): the plugin affirms
  // it, and nothing else counts. A failed send is definitive, and the reply can be thrown away, only if it is
  // refused (here, or by a code that is a local check made before anything was sent): a plugin that does not
  // say so leaves the reply as one that may have gone.
  readonly refused: boolean
  // The numeric code and subcode of the provider's own answer, for the logs only (Meta's `code` and
  // `error_subcode`). Numbers and nothing else, so they cannot carry a token; never sent to a client.
  readonly providerCode: number | undefined
  readonly providerSubcode: number | undefined
  // Which step of a send that has several failed (`upload 2/3`, `send`), for the logs only: a label made of words and
  // numbers, never a value of the provider or of the customer
  readonly step: string | undefined
  // The local check that refused (see PluginChecks), for the logs only: a name, never a value
  readonly failedCheck: PluginCheck | undefined
  // Why a connection failed, in the closed list of ChannelConnectFailureReasons: the one thing about a
  // failure that may reach the person, because it is a name that holds no value. Left out, it is the reason
  // of `failedCheck` when there is one.
  readonly reason: ChannelConnectFailureReason | undefined

  constructor(
    code: PluginErrorCode,
    options: {
      retryable?: boolean
      outcomeUnknown?: boolean
      refused?: boolean
      providerCode?: number
      providerSubcode?: number
      step?: string
      failedCheck?: PluginCheck
      reason?: ChannelConnectFailureReason
    } = {}
  ) {
    super(code, `channel plugin failed: ${code}`)
    this.name = 'PluginError'
    this.retryable = options.retryable
    this.outcomeUnknown = options.outcomeUnknown === true
    this.refused = options.refused === true && options.outcomeUnknown !== true
    this.providerCode = options.providerCode
    this.providerSubcode = options.providerSubcode
    this.step = options.step
    this.failedCheck = options.failedCheck
    // A check name outside the list (a plugin can be a third party's, and a type does not stop a string) gives
    // no reason, and never makes the construction fail
    // A reason outside the list is not kept (it would hide the one of the check), for the same reason
    this.reason = isChannelConnectFailureReason(options.reason)
      ? options.reason
      : isPluginCheck(options.failedCheck)
        ? connectReasonOfCheck(options.failedCheck)
        : undefined
  }
}

// A link to a file that the plugin will not follow because it is not where its provider keeps files
// (not its CDN, plain http, a port). The same answer on every try: the worker marks the file
// `unsafe_link`, as it does for a link it refuses itself, and does not ask again.
export class UnsafeMediaLinkError extends Error {
  constructor() {
    super('the link of a file is not one of the provider')
    this.name = 'UnsafeMediaLinkError'
  }
}
