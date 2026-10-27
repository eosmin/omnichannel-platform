import { type ErrorCode, type ErrorCodes, PlatformException } from '@platform/core/errors'

// The codes a plugin may raise: what a provider can do wrong, never a platform error
export type PluginErrorCode = Extract<
  ErrorCode,
  | typeof ErrorCodes.CHANNEL_MESSAGE_FAILED
  | typeof ErrorCodes.CHANNEL_CREDENTIALS_INVALID
  | typeof ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED
  | typeof ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
  | typeof ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID
>

// How a channel plugin reports a failure. It carries the code and nothing the provider said: the
// message and the metadata of a PlatformException reach the client and the logs as they are, and a
// provider's error body can echo the token it was called with. The core decides the answer from
// the code alone.
export class PluginError extends PlatformException {
  constructor(code: PluginErrorCode) {
    super(code, `channel plugin failed: ${code}`)
    this.name = 'PluginError'
  }
}
