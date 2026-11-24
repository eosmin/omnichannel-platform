import { ApiError } from '@platform/api-client'
import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

// The code to show for an error: the api sends codes and the interface translates them (messages
// `errors.<code>`, one for every code, which validate:translations enforces). Anything that is not an
// api error is the generic one. A code this page does not know yet (a server newer than the page) is
// kept as it came, and `useCodeText` shows the generic message for it: the browser holds no table of
// the codes, only the messages, so the page does not ship the whole table.
export function errorCodeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : ClientErrorCodes.INTERNAL_ERROR
}

// The permissions an api refusal says are missing; empty when it names none
export function missingPermissionsOf(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.PERMISSION_DENIED) return []
  // `metadata.required` is the one key the api lists the missing permissions under, from the guard and
  // from the checks inside a service alike
  const listed = error.metadata['required']
  if (!Array.isArray(listed)) return []
  return listed.filter((entry): entry is string => typeof entry === 'string')
}

const HOLDER_NAME_MAX_LENGTH = 80

// The store the api says holds a channel account (`metadata.storeName` of CHANNEL_ACCOUNT_IN_USE).
// The api sends it only to a member of that store; it is user text, so it is cut here and shown as
// plain text (React and the message formatter never read it as markup). Null when none came.
export function accountHolderOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.CHANNEL_ACCOUNT_IN_USE)
    return null
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
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.VALIDATION_FAILED) return null
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

const BYTES_PER_MEGABYTE = 1024 * 1024
const SECONDS_PER_MINUTE = 60
// A conflict kind is a snake_case name the api keeps in a constant; anything else is not looked up as a message key
const CONFLICT_KIND = /^[a-z][a-z0-9_]*$/

export interface ErrorDetail {
  // A message key of `errorDetails`
  key: string
  values?: Record<string, number>
}

// The sentence of an error that says more than its code does, when the api sent the number or the kind that makes it exact: the limit
// of a file that is too large, how long to wait after too many requests, which conflict a 409 is. Null when it sent none, so the caller
// shows the message of the code. `key` is a key of `errorDetails`; a conflict kind may have no sentence yet, so the caller checks it.
export function errorDetailOf(error: unknown): ErrorDetail | null {
  if (!(error instanceof ApiError)) return null
  if (error.code === ClientErrorCodes.FILE_TOO_LARGE) {
    const max = error.metadata['maxSizeBytes']
    if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return null
    return {
      key: 'errorDetails.fileTooLarge',
      values: { megabytes: Math.round((max / BYTES_PER_MEGABYTE) * 10) / 10 }
    }
  }
  if (error.code === ClientErrorCodes.RATE_LIMIT_EXCEEDED) {
    const wait = error.metadata[RETRY_AFTER_METADATA_KEY]
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait <= 0) return null
    return wait <= SECONDS_PER_MINUTE
      ? { key: 'errorDetails.rateLimitSeconds', values: { seconds: Math.ceil(wait) } }
      : {
          key: 'errorDetails.rateLimitMinutes',
          values: { minutes: Math.ceil(wait / SECONDS_PER_MINUTE) }
        }
  }
  if (error.code === ClientErrorCodes.RESOURCE_CONFLICT) {
    const kind = error.metadata['conflict']
    return typeof kind === 'string' && CONFLICT_KIND.test(kind)
      ? { key: `errorDetails.conflicts.${kind}` }
      : null
  }
  return null
}
