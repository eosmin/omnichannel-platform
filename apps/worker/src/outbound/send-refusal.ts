import { errorName, ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

// What the retry sees of a failed attempt: the code and the name of the error, never its text. The
// error of a plugin or of the network can carry the token it was called with, and BullMQ logs what is
// thrown and keeps it in Redis.
export class SendAttemptFailed extends Error {
  // The provider throttled the call: the retry waits longer for it (outboundBackoff)
  readonly throttled: boolean

  constructor(
    code: ErrorCode,
    cause: unknown,
    what:
      | 'a reply'
      | 'a reaction'
      | 'an edit'
      | 'a deletion'
      | 'a caption'
      | 'a read receipt' = 'a reply'
  ) {
    super(`sending ${what} failed: ${code} (${errorName(cause)})`)
    this.name = 'SendAttemptFailed'
    this.throttled = code === ErrorCodes.RATE_LIMIT_EXCEEDED
  }
}

// Why a send did not go out, and whether it is worth another try
export interface Refusal {
  code: ErrorCode
  retryable: boolean
}

// A plugin says whether to try again (it wins over anything else); a network error or a timeout is
// tried again, and so is anything else that is not the plugin's word: it is ours or the network's.
// That is for what is safe to repeat (reactions, receipts, edits). A message that shows a customer something
// asks `isRepeatableSend` instead, which does not repeat a doubt.
export function refusalOf(error: unknown): Refusal {
  if (error instanceof PluginError) {
    return { code: error.code, retryable: error.retryable === true }
  }
  return { code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: true }
}

// Whether a failed send of a message to a customer may be repeated by the job. The provider has no key that stops a
// second send, so a repeat after a doubt shows the customer the message twice. Only the plugin's own word counts:
// a PluginError that says `retryable` and does not say the outcome is unknown (a throttle, a file that could not be
// stored). A timeout of the worker, an error that is not the plugin's and a retry the plugin flags as unknown fail
// the send as one that may have gone, and the agent decides.
export function isRepeatableSend(error: unknown): boolean {
  return error instanceof PluginError && error.retryable === true && !error.outcomeUnknown
}
