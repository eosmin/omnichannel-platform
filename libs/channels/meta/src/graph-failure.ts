import { z } from 'zod'

import { MetaErrorCodes, MetaTransientStatuses } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

const graphErrorSchema = z.object({
  error: z.object({ code: z.number().int() })
})

function isRateLimitCode(code: number): boolean {
  return MetaErrorCodes.RATE_LIMITS.some(limit => limit === code)
}

function isOutageCode(code: number): boolean {
  return MetaErrorCodes.TEMPORARY.some(temporary => temporary === code)
}

function isCredentialsCode(code: number): boolean {
  return (
    code === MetaErrorCodes.INVALID_TOKEN ||
    code === MetaErrorCodes.PERMISSION_DENIED ||
    (code >= MetaErrorCodes.PERMISSION_RANGE_START && code <= MetaErrorCodes.PERMISSION_RANGE_END)
  )
}

// A failed call to the Graph API as the error the core understands. Only the code of the answer is
// read: its message and trace id are not kept, because a provider's error text can echo the token the
// call carried (PluginError says why).
//
// `safeToRepeat` is false for a call that changes something on Meta's side (sending a message). A
// throttle means Meta did not do the work, so it is always worth trying again; a 5xx or an outage
// code says nothing about whether it was done, and sending again could reach the customer twice. So
// those are retryable only for a call that is safe to repeat. The server side is read before the
// credentials: an outage that carries a permission code is not a bad token.
export function graphFailure(
  status: number,
  body: unknown,
  { safeToRepeat }: { safeToRepeat: boolean } = { safeToRepeat: true }
): PluginError {
  const parsed = graphErrorSchema.safeParse(body)
  const code = parsed.success ? parsed.data.error.code : undefined

  // Meta sometimes answers a throttle with a 403: the code says what it is, and a healthy connection
  // must not be put in error for it
  if (
    status === HttpStatusCodes.TOO_MANY_REQUESTS ||
    (code !== undefined && isRateLimitCode(code))
  ) {
    return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
  }
  if (
    status >= HttpStatusCodes.INTERNAL_SERVER_ERROR ||
    MetaTransientStatuses.some(transient => transient === status) ||
    (code !== undefined && isOutageCode(code))
  ) {
    return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: safeToRepeat })
  }
  if (
    status === HttpStatusCodes.UNAUTHORIZED ||
    status === HttpStatusCodes.FORBIDDEN ||
    (code !== undefined && isCredentialsCode(code))
  ) {
    return new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
  }
  return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
}

// The call got no answer (network, timeout). For a call that is safe to repeat that is worth another
// try; for a send, the message may already be on its way, so it is not tried again.
export function graphUnreachable(
  { safeToRepeat }: { safeToRepeat: boolean } = { safeToRepeat: true }
): PluginError {
  return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: safeToRepeat })
}

// Meta answered something that is not what its API says: the same call would answer the same
export function graphUnexpected(): PluginError {
  return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
}

// The file behind a media url failed. The url is short-lived, so a 401, 403, 404 or 410 says the url
// expired, not that the token is bad: asking again gets a fresh url. Marking the connection in error
// for it would cut off a healthy one.
export function graphFileFailure(status: number): PluginError {
  const expired =
    status === HttpStatusCodes.UNAUTHORIZED ||
    status === HttpStatusCodes.FORBIDDEN ||
    status === HttpStatusCodes.NOT_FOUND ||
    status === HttpStatusCodes.GONE
  return expired
    ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
    : graphFailure(status, null)
}
