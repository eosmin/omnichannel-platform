import {
  ChannelConnectFailureReasons,
  type ChannelConnectFailureReason
} from '@platform/core/errors'
import { connectFailureReasonOf } from '@platform/plugins/sdk'

import { ProviderTimeoutError } from './timeout'

// The reason, of the closed list, that a failure of a provider call gives for the person to read: the one the
// plugin named, the provider being slow when the call ran out of time, and nothing else (never a text of the
// provider). One place, so the connection and the login word a failure the same way.
export function connectReasonOfError(error: unknown): ChannelConnectFailureReason | undefined {
  return (
    connectFailureReasonOf(error) ??
    (error instanceof ProviderTimeoutError
      ? ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
      : undefined)
  )
}
