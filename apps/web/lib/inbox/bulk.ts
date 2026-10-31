import type {
  BulkOperation,
  BulkResultView,
  BulkTarget,
  ConversationListItemView
} from '@platform/api-client'
import { BulkActions, BulkLimits, ConversationStatus } from '@platform/core/domain'

// How the interface asks before a bulk action (TDD_09 §10): archiving needs the phrase typed, many
// conversations need a dialog with what will change, and a few reversible ones act at once.
export const BulkConfirmations = {
  NONE: 'none',
  DIALOG: 'dialog',
  TYPED: 'typed'
} as const
export type BulkConfirmation = (typeof BulkConfirmations)[keyof typeof BulkConfirmations]

// `count` is null for "all matching": the number reached is not known until the server answers
export function confirmationOf(operation: BulkOperation, count: number | null): BulkConfirmation {
  if (operation.action === BulkActions.ARCHIVE) return BulkConfirmations.TYPED
  if (count === null || count >= BulkLimits.CONFIRM_FROM) return BulkConfirmations.DIALOG
  return BulkConfirmations.NONE
}

// What a conversation was before the action, read from the row the agent ticked
export type PreviousState = Pick<
  ConversationListItemView,
  'id' | 'status' | 'assignedTo' | 'unreadCount' | 'tags'
>

export interface UndoStep {
  operation: BulkOperation
  conversationIds: string[]
}

type Settable = ConversationStatus.OPEN | ConversationStatus.PENDING | ConversationStatus.RESOLVED
const SETTABLE: readonly string[] = [
  ConversationStatus.OPEN,
  ConversationStatus.PENDING,
  ConversationStatus.RESOLVED
]

function groupBy<Key>(
  states: readonly PreviousState[],
  keyOf: (state: PreviousState) => Key
): Map<Key, string[]> {
  const groups = new Map<Key, string[]>()
  for (const state of states) {
    const key = keyOf(state)
    groups.set(key, [...(groups.get(key) ?? []), state.id])
  }
  return groups
}

// The steps that put back what an action changed, for the conversations that went through. Each
// conversation goes back to what it was, so a group of different states takes more than one step.
// An action that cannot be taken back (archiving) or a conversation whose old state cannot be set
// again (it was snoozed or archived) gives no step: the toast then offers no Undo for them.
export function undoStepsOf(
  operation: BulkOperation,
  previous: readonly PreviousState[],
  succeeded: readonly string[]
): UndoStep[] {
  const done = new Set(succeeded)
  const states = previous.filter(state => done.has(state.id))
  const steps: UndoStep[] = []

  switch (operation.action) {
    case BulkActions.ASSIGN_TO_ME:
    case BulkActions.ASSIGN_TO_AGENT:
    case BulkActions.ROUND_ROBIN_TO_TEAM:
    case BulkActions.UNASSIGN:
      for (const [userId, ids] of groupBy(states, state => state.assignedTo)) {
        steps.push({
          operation:
            userId === null
              ? { action: BulkActions.UNASSIGN }
              : { action: BulkActions.ASSIGN_TO_AGENT, params: { userId } },
          conversationIds: ids
        })
      }
      break
    case BulkActions.SET_STATUS:
      for (const [status, ids] of groupBy(states, state => state.status)) {
        if (!SETTABLE.includes(status)) continue
        steps.push({
          operation: {
            action: BulkActions.SET_STATUS,
            params: { status: status as Settable }
          },
          conversationIds: ids
        })
      }
      break
    case BulkActions.ADD_TAG:
    case BulkActions.REMOVE_TAG: {
      const adds = operation.action === BulkActions.ADD_TAG
      const { tagId } = operation.params
      // Only the conversations the action really changed: a tag that was already there is not removed
      const changed = states.filter(state => state.tags.some(tag => tag.id === tagId) !== adds)
      if (changed.length > 0) {
        steps.push({
          operation: {
            action: adds ? BulkActions.REMOVE_TAG : BulkActions.ADD_TAG,
            params: { tagId }
          },
          conversationIds: changed.map(state => state.id)
        })
      }
      break
    }
    case BulkActions.MARK_READ: {
      const ids = states.filter(state => state.unreadCount > 0).map(state => state.id)
      if (ids.length > 0) {
        steps.push({ operation: { action: BulkActions.MARK_UNREAD }, conversationIds: ids })
      }
      break
    }
    case BulkActions.MARK_UNREAD: {
      const ids = states.filter(state => state.unreadCount === 0).map(state => state.id)
      if (ids.length > 0) {
        steps.push({ operation: { action: BulkActions.MARK_READ }, conversationIds: ids })
      }
      break
    }
    case BulkActions.ARCHIVE:
      break
  }
  return steps
}

export const BulkOutcomes = {
  ALL_DONE: 'all_done',
  SOME_DONE: 'some_done',
  NONE_DONE: 'none_done'
} as const
export type BulkOutcome = (typeof BulkOutcomes)[keyof typeof BulkOutcomes]

export interface BulkSummary {
  outcome: BulkOutcome
  succeeded: number
  failed: number
  // The codes of the failures with how many conversations each reached, most frequent first
  reasons: { code: string; count: number }[]
  truncated: boolean
}

export function summaryOf(result: BulkResultView): BulkSummary {
  const counts = new Map<string, number>()
  for (const failure of result.failed) counts.set(failure.code, (counts.get(failure.code) ?? 0) + 1)
  const reasons = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
  const succeeded = result.succeeded.length
  const failed = result.failed.length
  const outcome =
    failed === 0
      ? BulkOutcomes.ALL_DONE
      : succeeded === 0
        ? BulkOutcomes.NONE_DONE
        : BulkOutcomes.SOME_DONE
  return { outcome, succeeded, failed, reasons, truncated: result.truncated }
}

export function targetCountOf(target: BulkTarget): number | null {
  return 'conversationIds' in target ? target.conversationIds.length : null
}

// The text that tells what a single-conversation action did, with the name of the customer after it
// ("Resolved: Ana"); a key of `inbox.bulk.result.one`
export type SingleResultKey =
  | 'assignedToYou'
  | 'assigned'
  | 'unassigned'
  | 'open'
  | 'pending'
  | 'resolved'
  | 'tagAdded'
  | 'tagRemoved'
  | 'markedRead'
  | 'markedUnread'
  | 'archived'
  | 'updated'

export function singleResultKey(operation: BulkOperation): SingleResultKey {
  switch (operation.action) {
    case BulkActions.ASSIGN_TO_ME:
      return 'assignedToYou'
    case BulkActions.ASSIGN_TO_AGENT:
    case BulkActions.ROUND_ROBIN_TO_TEAM:
      return 'assigned'
    case BulkActions.UNASSIGN:
      return 'unassigned'
    case BulkActions.SET_STATUS:
      if (operation.params.status === ConversationStatus.OPEN) return 'open'
      if (operation.params.status === ConversationStatus.PENDING) return 'pending'
      return 'resolved'
    case BulkActions.ADD_TAG:
      return 'tagAdded'
    case BulkActions.REMOVE_TAG:
      return 'tagRemoved'
    case BulkActions.MARK_READ:
      return 'markedRead'
    case BulkActions.MARK_UNREAD:
      return 'markedUnread'
    case BulkActions.ARCHIVE:
      return 'archived'
    default:
      return 'updated'
  }
}
