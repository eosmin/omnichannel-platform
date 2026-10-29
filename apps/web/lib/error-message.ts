import { ApiError } from '@platform/api-client'
import { type ErrorCode, ErrorCodes } from '@platform/core/errors'

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCodes))

// The code to show for an error: the api sends codes and the interface translates them (messages
// `errors.<code>`, one for every code, which validate:translations enforces). A code this page does
// not know yet (a server newer than the page), and anything that is not an api error, shows the
// generic message.
export function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof ApiError && KNOWN_CODES.has(error.code)
    ? (error.code as ErrorCode) // Narrowed by the set above
    : ErrorCodes.INTERNAL_ERROR
}
