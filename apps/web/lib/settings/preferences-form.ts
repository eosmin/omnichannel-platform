import type { FailedAttemptMessagePolicyType, OrderFreeShippingRule } from '@platform/core/domain'
import {
  type CancellationReason,
  CancellationReasonLimits,
  defaultCancellationReasons,
  RemittancePreferenceLimits
} from '@platform/core/store-preferences'

import type { PreferencesInput, PreferencesView } from './preferences-requests'

// The form of Settings → Preferences as plain values, and the checks done before the request. The api checks the same and
// decides. The discount limit and the price-override notice are approval controls with no write path here (see the plan, Step 4.14).
// The keys the Inbox behavior page draws (`sendReadReceipts`, `assignOnReply`) and the returns block are not here.

export interface PreferencesDraft {
  confirmOnCreate: boolean
  sendSummaryOnCreate: boolean
  freeShippingRule: OrderFreeShippingRule
  failedAttemptMessages: FailedAttemptMessagePolicyType
  // Digits as typed
  overdueAfterDays: string
  cancellationReasons: CancellationReason[]
}

export const PreferencesProblems = {
  OVERDUE_DAYS: 'overdueDays',
  REASONS_EMPTY: 'reasonsEmpty',
  REASONS_TOO_MANY: 'reasonsTooMany',
  REASON_BLANK: 'reasonBlank',
  REASON_TOO_LONG: 'reasonTooLong',
  REASON_DUPLICATE: 'reasonDuplicate'
} as const
export type PreferencesProblem = (typeof PreferencesProblems)[keyof typeof PreferencesProblems]

export function preferencesDraftOf(view: PreferencesView): PreferencesDraft {
  return {
    confirmOnCreate: view.orders.confirmOnCreate,
    sendSummaryOnCreate: view.orders.sendSummaryOnCreate,
    freeShippingRule: view.orders.freeShippingRule,
    failedAttemptMessages: view.orders.failedAttemptMessages,
    overdueAfterDays: String(view.remittances.overdueAfterDays),
    cancellationReasons: view.orders.cancellationReasons.map(reason => ({ ...reason }))
  }
}

// Digits only ('1e2' and '7.5' are not whole numbers) inside the range; undefined is a text that is neither
function wholeNumberIn(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= min && value <= max ? value : undefined
}

function textOf(reason: CancellationReason): string {
  return (reason.labelKey ?? reason.label ?? '').trim().toLowerCase()
}

export function preferencesProblems(draft: PreferencesDraft): PreferencesProblem[] {
  const problems = new Set<PreferencesProblem>()
  if (
    wholeNumberIn(
      draft.overdueAfterDays,
      RemittancePreferenceLimits.MIN_OVERDUE_DAYS,
      RemittancePreferenceLimits.MAX_OVERDUE_DAYS
    ) === undefined
  ) {
    problems.add(PreferencesProblems.OVERDUE_DAYS)
  }
  const reasons = draft.cancellationReasons
  if (reasons.length === 0) problems.add(PreferencesProblems.REASONS_EMPTY)
  if (reasons.length > CancellationReasonLimits.MAX_ENTRIES) {
    problems.add(PreferencesProblems.REASONS_TOO_MANY)
  }
  for (const reason of reasons) {
    if (reason.label === undefined) continue
    const length = reason.label.trim().length
    if (length === 0) problems.add(PreferencesProblems.REASON_BLANK)
    if (length > CancellationReasonLimits.MAX_LABEL_LENGTH) {
      problems.add(PreferencesProblems.REASON_TOO_LONG)
    }
  }
  const texts = reasons.map(textOf).filter(text => text !== '')
  if (new Set(texts).size !== texts.length) problems.add(PreferencesProblems.REASON_DUPLICATE)
  return [...problems]
}

// The reasons as the api takes them: the text of a custom one trimmed
function reasonsOf(reasons: readonly CancellationReason[]): CancellationReason[] {
  return reasons.map(reason =>
    reason.label === undefined ? reason : { id: reason.id, label: reason.label.trim() }
  )
}

// Only what the person changed: a key they never touched must not overwrite what another person saved. Null is nothing
// to send. Call it with a draft that has no problems.
export function preferencesChanges(
  saved: PreferencesView,
  draft: PreferencesDraft
): PreferencesInput | null {
  const orders: NonNullable<PreferencesInput['orders']> = {}
  if (draft.confirmOnCreate !== saved.orders.confirmOnCreate) {
    orders.confirmOnCreate = draft.confirmOnCreate
  }
  if (draft.sendSummaryOnCreate !== saved.orders.sendSummaryOnCreate) {
    orders.sendSummaryOnCreate = draft.sendSummaryOnCreate
  }
  if (draft.freeShippingRule !== saved.orders.freeShippingRule) {
    orders.freeShippingRule = draft.freeShippingRule
  }
  if (draft.failedAttemptMessages !== saved.orders.failedAttemptMessages) {
    orders.failedAttemptMessages = draft.failedAttemptMessages
  }
  const reasons = reasonsOf(draft.cancellationReasons)
  if (JSON.stringify(reasons) !== JSON.stringify(reasonsOf(saved.orders.cancellationReasons))) {
    orders.cancellationReasons = reasons
  }
  const changes: PreferencesInput = {}
  if (Object.keys(orders).length > 0) changes.orders = orders
  const overdue = wholeNumberIn(
    draft.overdueAfterDays,
    RemittancePreferenceLimits.MIN_OVERDUE_DAYS,
    RemittancePreferenceLimits.MAX_OVERDUE_DAYS
  )
  if (overdue !== undefined && overdue !== saved.remittances.overdueAfterDays) {
    changes.remittances = { overdueAfterDays: overdue }
  }
  return Object.keys(changes).length > 0 ? changes : null
}

// The id of a reason the store types: the smallest `custom-N` not in use, so two reasons never share one
export function nextReasonId(reasons: readonly CancellationReason[]): string {
  const used = new Set(reasons.map(reason => reason.id))
  let n = 1
  while (used.has(`custom-${n}`)) n += 1
  return `custom-${n}`
}

export function addCustomReason(
  reasons: readonly CancellationReason[],
  label: string
): CancellationReason[] {
  return [...reasons, { id: nextReasonId(reasons), label }]
}

export function renameReason(
  reasons: readonly CancellationReason[],
  id: string,
  label: string
): CancellationReason[] {
  return reasons.map(reason =>
    reason.id === id && reason.label !== undefined ? { id, label } : reason
  )
}

export function removeReason(
  reasons: readonly CancellationReason[],
  id: string
): CancellationReason[] {
  return reasons.filter(reason => reason.id !== id)
}

// One place up (-1) or down (1); at the edge nothing moves
export function moveReason(
  reasons: readonly CancellationReason[],
  id: string,
  step: -1 | 1
): CancellationReason[] {
  const from = reasons.findIndex(reason => reason.id === id)
  const to = from + step
  if (from < 0 || to < 0 || to >= reasons.length) return [...reasons]
  const next = [...reasons]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

export function factoryReasons(): CancellationReason[] {
  return defaultCancellationReasons.map(reason => ({ ...reason }))
}
