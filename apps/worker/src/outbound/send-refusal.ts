import { errorName } from '@platform/channels/connections'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

// What the retry sees of a failed attempt: the code and the name of the error, never its text. The
// error of a plugin or of the network can carry the token it was called with, and BullMQ logs what is
// thrown and keeps it in Redis.
export class SendAttemptFailed extends Error {
  constructor(
    code: ErrorCode,
    cause: unknown,
    what: 'a reply' | 'a reaction' | 'an edit' | 'a deletion' | 'a read receipt' = 'a reply'
  ) {
    super(`sending ${what} failed: ${code} (${errorName(cause)})`)
    this.name = 'SendAttemptFailed'
  }
}

// Why a send did not go out, and whether it is worth another try
export interface Refusal {
  code: ErrorCode
  retryable: boolean
}

// A plugin says whether to try again (it wins over anything else); a network error or a timeout is
// tried again, and so is anything else that is not the plugin's word: it is ours or the network's
export function refusalOf(error: unknown): Refusal {
  if (error instanceof PluginError) {
    return { code: error.code, retryable: error.retryable === true }
  }
  return { code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: true }
}
