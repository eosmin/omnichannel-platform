import { type PluginCheck } from '@platform/core/errors'
import { PluginError, type PluginErrorCode } from '@platform/plugins/sdk'

// The same failure with the check that refused named, for the logs: the code, whether it may be tried
// again and the numbers of the provider are the ones it came with. What is not a plugin error is not
// ours to name and goes on as it is.
export function withCheck(error: unknown, failedCheck: PluginCheck): unknown {
  if (!(error instanceof PluginError)) return error
  return new PluginError(error.code as PluginErrorCode, {
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.outcomeUnknown ? { outcomeUnknown: true } : {}),
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.providerSubcode === undefined ? {} : { providerSubcode: error.providerSubcode }),
    // A check the failure already carries is the more exact cause
    failedCheck: error.failedCheck ?? failedCheck
  })
}
