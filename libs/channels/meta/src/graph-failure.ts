import { z } from 'zod'

import { MetaErrorCodes, MetaTransientStatuses, WhatsAppErrorCodes } from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

const graphErrorSchema = z.object({
  error: z.object({ code: z.number().int(), error_subcode: z.number().int().optional() })
})

function isRateLimitCode(code: number): boolean {
  return MetaErrorCodes.RATE_LIMITS.some(limit => limit === code)
}

function isOutageCode(code: number): boolean {
  return MetaErrorCodes.TEMPORARY.some(temporary => temporary === code)
}

// A permission Meta says is missing: code 10, or 200 to 299
export function isPermissionCode(code: number): boolean {
  return (
    code === MetaErrorCodes.PERMISSION_DENIED ||
    (code >= MetaErrorCodes.PERMISSION_RANGE_START && code <= MetaErrorCodes.PERMISSION_RANGE_END)
  )
}

function isCredentialsCode(code: number): boolean {
  return code === MetaErrorCodes.INVALID_TOKEN || isPermissionCode(code)
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
  const subcode = parsed.success ? parsed.data.error.error_subcode : undefined
  // The two numbers of the answer go with the error, for the logs: nothing else of it does
  const seen = {
    ...(code === undefined ? {} : { providerCode: code }),
    ...(subcode === undefined ? {} : { providerSubcode: subcode })
  }

  // Meta sometimes answers a throttle with a 403: the code says what it is, and a healthy connection
  // must not be put in error for it
  if (
    status === HttpStatusCodes.TOO_MANY_REQUESTS ||
    (code !== undefined && isRateLimitCode(code))
  ) {
    return new PluginError(ErrorCodes.RATE_LIMIT_EXCEEDED, {
      ...seen,
      retryable: true,
      // A throttle: Meta did not do the work
      refused: true,
      reason: ChannelConnectFailureReasons.PROVIDER_BUSY
    })
  }
  if (
    status >= HttpStatusCodes.INTERNAL_SERVER_ERROR ||
    MetaTransientStatuses.some(transient => transient === status) ||
    (code !== undefined && isOutageCode(code))
  ) {
    return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
      ...seen,
      retryable: safeToRepeat,
      outcomeUnknown: !safeToRepeat,
      reason: ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
    })
  }
  // Not a failure of the call: this person has no profile to read, and asking again changes nothing
  if (code === MetaErrorCodes.NO_PROFILE) {
    return new PluginError(ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE, { ...seen, retryable: false })
  }
  // The agent can act on this one: pick another template, or wait for the approval
  if (code !== undefined && WhatsAppErrorCodes.TEMPLATE_UNAVAILABLE.some(known => known === code)) {
    return new PluginError(ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED, {
      ...seen,
      retryable: false,
      refused: true
    })
  }
  if (code !== undefined && WhatsAppErrorCodes.WINDOW_CLOSED.some(known => known === code)) {
    return new PluginError(ErrorCodes.CHANNEL_WINDOW_EXPIRED, {
      ...seen,
      retryable: false,
      refused: true
    })
  }
  if (
    status === HttpStatusCodes.UNAUTHORIZED ||
    status === HttpStatusCodes.FORBIDDEN ||
    (code !== undefined && isCredentialsCode(code))
  ) {
    return new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      ...seen,
      retryable: false,
      refused: true,
      reason: credentialsReasonOf(status, code)
    })
  }
  return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
    ...seen,
    retryable: false,
    // Meta answered, and not with a failure of its own (5xx and outages are above): it refused the request
    refused: true,
    // Meta answers 100 for a field, a permission or a kind of token that it does not take
    ...(code === MetaErrorCodes.INVALID_PARAMETER
      ? { reason: ChannelConnectFailureReasons.REQUEST_REJECTED }
      : {})
  })
}

// A token Meta refused (190, or any 401: the status says the token, whatever number goes with it) is one to
// generate again; a permission it denied (10 or 200 to 299) is one to grant. Any other refusal, such as a 403
// that comes with no code of Meta, says nothing about which: the generic message shows.
function credentialsReasonOf(
  status: number,
  code: number | undefined
):
  | typeof ChannelConnectFailureReasons.TOKEN_REJECTED
  | typeof ChannelConnectFailureReasons.PERMISSION_MISSING
  | undefined {
  if (code === MetaErrorCodes.INVALID_TOKEN || status === HttpStatusCodes.UNAUTHORIZED) {
    return ChannelConnectFailureReasons.TOKEN_REJECTED
  }
  return code !== undefined && isCredentialsCode(code)
    ? ChannelConnectFailureReasons.PERMISSION_MISSING
    : undefined
}

// The call got no answer (network, timeout). For a call that is safe to repeat that is worth another
// try; for a send, the message may already be on its way, so it is not tried again.
export function graphUnreachable(
  { safeToRepeat }: { safeToRepeat: boolean } = { safeToRepeat: true }
): PluginError {
  return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
    retryable: safeToRepeat,
    outcomeUnknown: !safeToRepeat,
    reason: ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
  })
}

// Meta answered something that is not what its API says: the same call would answer the same
export function graphUnexpected(): PluginError {
  return new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
    retryable: false,
    reason: ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
  })
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
