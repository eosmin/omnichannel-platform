import { ApiError } from '@platform/api-client'
import {
  type ChannelConnectFailureReason,
  ChannelConnectFailureReasons,
  type ErrorCode,
  ErrorCodes,
  isChannelConnectFailureReason
} from '@platform/core/errors'

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ErrorCodes))

// The code to show for an error: the api sends codes and the interface translates them (messages
// `errors.<code>`, one for every code, which validate:translations enforces). A code this page does
// not know yet (a server newer than the page), and anything that is not an api error, shows the
// generic message.
export function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof ApiError ? knownErrorCode(error.code) : ErrorCodes.INTERNAL_ERROR
}

// The same for a code that came as plain text (the reason a message was not delivered)
export function knownErrorCode(code: string): ErrorCode {
  return KNOWN_CODES.has(code) ? (code as ErrorCode) : ErrorCodes.INTERNAL_ERROR // Narrowed by the set
}

// The metadata keys under which the api lists the permissions a refusal says are missing: `required`
// (the permission guard) and `permissions` (the checks inside a service, such as the status of a
// conversation or the role of a member). Both mean the same, so both are read.
const MISSING_PERMISSIONS_KEYS = ['required', 'permissions'] as const

// The permissions an api refusal says are missing; empty when it names none
export function missingPermissionsOf(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== ErrorCodes.PERMISSION_DENIED) return []
  for (const key of MISSING_PERMISSIONS_KEYS) {
    const listed = error.metadata[key]
    if (!Array.isArray(listed)) continue
    const names = listed.filter((entry): entry is string => typeof entry === 'string')
    if (names.length > 0) return names
  }
  return []
}

const HOLDER_NAME_MAX_LENGTH = 80

// The store the api says holds a channel account (`metadata.storeName` of CHANNEL_ACCOUNT_IN_USE).
// The api sends it only to a member of that store; it is user text, so it is cut here and shown as
// plain text (React and the message formatter never read it as markup). Null when none came.
export function accountHolderOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== ErrorCodes.CHANNEL_ACCOUNT_IN_USE) return null
  const name = error.metadata['storeName']
  if (typeof name !== 'string' || name.trim() === '') return null
  return Array.from(name.trim()).slice(0, HOLDER_NAME_MAX_LENGTH).join('')
}

export interface FieldIssue {
  // The name of the field in the body (`phone`)
  field: string
  // The position inside a list field (`siteOrigins.1` is the second), or null
  index: number | null
}

// The first field a validation refusal names (`metadata.issues[].path`), so the interface can say
// which one to check instead of "some fields are not valid"; null when it names none
export function firstIssueOf(error: unknown): FieldIssue | null {
  if (!(error instanceof ApiError) || error.code !== ErrorCodes.VALIDATION_FAILED) return null
  const issues = error.metadata['issues']
  if (!Array.isArray(issues)) return null
  for (const issue of issues as unknown[]) {
    const path = (issue as { path?: unknown } | null)?.path
    if (typeof path !== 'string' || path === '') continue
    const [field = '', second] = path.split('.')
    const index = second !== undefined && /^\d+$/.test(second) ? Number(second) : null
    return { field, index }
  }
  return null
}

// Why a channel was not connected (`metadata.reason` of CHANNEL_CREDENTIALS_INVALID): a name of the closed
// list, which the page has a text for. A name the page does not know yet (a server newer than the page),
// a value that is not text, or any other error is null, and the generic message of the code shows.
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
    case ChannelConnectFailureReasons.TOKEN_MISSING:
    case ChannelConnectFailureReasons.TOKEN_MALFORMED:
    case ChannelConnectFailureReasons.TOKEN_REJECTED:
    case ChannelConnectFailureReasons.PERMISSION_MISSING:
    case ChannelConnectFailureReasons.REQUEST_REJECTED:
      return true
    default:
      return false
  }
}
