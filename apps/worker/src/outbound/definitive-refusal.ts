import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

// A plugin refuses with one of these when the check is its own and made before anything is sent (a channel that
// takes no files, a file too big, a token the plugin sees is wrong): the provider was never asked
const LOCAL_REFUSALS: readonly ErrorCode[] = [
  ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
  ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED,
  ErrorCodes.CHANNEL_FILE_TOO_LARGE,
  ErrorCodes.CHANNEL_NOT_CONNECTED,
  ErrorCodes.FILE_UNAVAILABLE
]

// Whether a failed send is known not to have been taken by the provider: a PluginError that does not say the
// outcome is unknown AND that affirms the refusal (`refused`, which the provider's own answer sets) or is a
// local check of the list above. Anything else, a PluginError that says nothing included, is a send that may
// have gone: the reply can be sent again, not thrown away.
export function isDefinitiveRefusal(error: unknown): boolean {
  if (!(error instanceof PluginError) || error.outcomeUnknown) return false
  return error.refused || LOCAL_REFUSALS.includes(error.code)
}
