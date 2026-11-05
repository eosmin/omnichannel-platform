import { ApiError } from '@platform/api-client'
import {
  type ChannelConnectFailureReason,
  ChannelConnectFailureReasons,
  ErrorCodes,
  isChannelConnectFailureReason
} from '@platform/core/errors'

// Why a channel was not connected (`metadata.reason` of CHANNEL_CREDENTIALS_INVALID): a name of the closed
// list, which the page has a text for. A name the page does not know yet (a server newer than the page),
// a value that is not text, or any other error is null, and the generic message of the code shows.
// Only the settings pages import this file: the inbox must not carry it (its script budget has no room).
export function connectFailureReasonOf(error: unknown): ChannelConnectFailureReason | null {
  if (!(error instanceof ApiError) || error.code !== ErrorCodes.CHANNEL_CREDENTIALS_INVALID) {
    return null
  }
  const reason = error.metadata['reason']
  return isChannelConnectFailureReason(reason) ? reason : null
}

// The reasons that are about what was pasted or what it may do: the focus goes back to the token field
export function isTokenFailure(reason: ChannelConnectFailureReason | null): boolean {
  switch (reason) {
    case ChannelConnectFailureReasons.TOKEN_MALFORMED:
    case ChannelConnectFailureReasons.TOKEN_REJECTED:
    case ChannelConnectFailureReasons.PERMISSION_MISSING:
    case ChannelConnectFailureReasons.REQUEST_REJECTED:
      return true
    default:
      return false
  }
}
