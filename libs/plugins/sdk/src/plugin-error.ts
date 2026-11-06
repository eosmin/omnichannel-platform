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
  | typeof ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED
  | typeof ErrorCodes.CHANNEL_WINDOW_EXPIRED
  | typeof ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
  | typeof ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED
  | typeof ErrorCodes.CHANNEL_FILE_TOO_LARGE
  | typeof ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE
  | typeof ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID
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
  // unreadable 2xx): the provider may have done the work. False or left out: it did not.
  readonly outcomeUnknown: boolean
  // The numeric code and subcode of the provider's own answer, for the logs only (Meta's `code` and
  // `error_subcode`). Numbers and nothing else, so they cannot carry a token; never sent to a client.
  readonly providerCode: number | undefined
  readonly providerSubcode: number | undefined
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
      providerCode?: number
      providerSubcode?: number
      failedCheck?: PluginCheck
      reason?: ChannelConnectFailureReason
    } = {}
  ) {
    super(code, `channel plugin failed: ${code}`)
    this.name = 'PluginError'
    this.retryable = options.retryable
    this.outcomeUnknown = options.outcomeUnknown === true
    this.providerCode = options.providerCode
    this.providerSubcode = options.providerSubcode
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
