import { type MediaFileProblem } from '@platform/core/channel-media'
import { ErrorCodes } from '@platform/core/errors'

import type { PluginErrorCode } from './plugin-error'

// The code that says why the rules of a channel refuse a file: one table for the worker, which checks before it
// opens anything, and for the plugins, which check before they send, so that both name a refusal the same way
export const ErrorCodeOfMediaProblem: Readonly<Record<MediaFileProblem, PluginErrorCode>> = {
  type: ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED,
  empty: ErrorCodes.CHANNEL_MESSAGE_FAILED,
  too_large: ErrorCodes.CHANNEL_FILE_TOO_LARGE
}
