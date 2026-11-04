import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

// The people a conversation can be given to: those whose role can open it and answer it, which is the
// rule the api applies when it assigns (a refusal of anyone else reads "assignee not found"). The
// member directory names everyone and says which of them these are.
export function assignableOnly<T extends { canBeAssigned: boolean }>(members: readonly T[]): T[] {
  return members.filter(member => member.canBeAssigned)
}

// An assignment the api answers with "not found" is not a missing page: the api gives that one answer
// when the conversation is gone and when the person cannot be given it (they left the store, or their
// role cannot answer), so as not to tell which. The interface says both.
export function isAssigneeRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.code === ErrorCodes.RESOURCE_NOT_FOUND
}
