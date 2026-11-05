import {
  type ChannelConnectFailureReason,
  isChannelConnectFailureReason
} from '@platform/core/errors'

import { PluginError } from './plugin-error'

// The reason, of the closed list, that a failure of a plugin gives for the person to read; nothing for any
// other error or for a name that is not of the list (a plugin can be a third party's, and a type does not
// stop a string)
export function connectFailureReasonOf(error: unknown): ChannelConnectFailureReason | undefined {
  return error instanceof PluginError && isChannelConnectFailureReason(error.reason)
    ? error.reason
    : undefined
}
