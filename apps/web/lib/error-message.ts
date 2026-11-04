import { ApiError } from '@platform/api-client'
import { type ErrorCode, ErrorCodes } from '@platform/core/errors'

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

// The permissions an api refusal says are missing (`metadata.required`); empty when it names none
export function missingPermissionsOf(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== ErrorCodes.PERMISSION_DENIED) return []
  const required = error.metadata['required']
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === 'string')
    : []
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
