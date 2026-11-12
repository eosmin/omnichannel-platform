import type { ReceptionBatchSummaryView, ReceptionItemView } from '@platform/api-client'
import {
  type OrderReturnCondition,
  ReceptionBatchStatus,
  ReceptionItemOutcome,
  type UpdateReceptionItemBody
} from '@platform/core/domain'

import { asReturnReasonKey } from '../orders/order-returns-rules'

// The pure rules of the reception screen (TDD_17 §4.16): which batch is the one being worked on, what state each scanned
// package is in, and what a change of the editor sends. Nothing here reads the network or the environment.

// A draft waits for more scans; a batch that ended with errors waits only while a package is still failed or pending (once
// they were all fixed or removed there is nothing left to do with it); one being processed is shown, locked, so that it is
// followed and never hidden behind a second batch. Every other batch is history.
const EDITABLE_STATUSES: readonly ReceptionBatchStatus[] = [
  ReceptionBatchStatus.DRAFT,
  ReceptionBatchStatus.COMPLETED_WITH_ERRORS
]

function isOpen(batch: ReceptionBatchSummaryView): boolean {
  if (batch.status === ReceptionBatchStatus.DRAFT) return true
  if (batch.status === ReceptionBatchStatus.PROCESSING) return true
  return (
    batch.status === ReceptionBatchStatus.COMPLETED_WITH_ERRORS &&
    batch.counts.failed + batch.counts.pending > 0
  )
}

// The newest open batch of the list, or null when there is none
export function openBatchOf(
  batches: readonly ReceptionBatchSummaryView[]
): ReceptionBatchSummaryView | null {
  const open = batches.filter(isOpen)
  if (open.length === 0) return null
  return open.reduce((newest, batch) => (batch.createdAt > newest.createdAt ? batch : newest))
}

export const ReceptionItemStates = {
  PENDING: 'pending',
  RECEIVED: 'received',
  FAILED: 'failed'
} as const
export type ReceptionItemState = (typeof ReceptionItemStates)[keyof typeof ReceptionItemStates]

export function itemStateOf(item: Pick<ReceptionItemView, 'outcome'>): ReceptionItemState {
  if (item.outcome === ReceptionItemOutcome.RECEIVED) return ReceptionItemStates.RECEIVED
  if (item.outcome === ReceptionItemOutcome.FAILED) return ReceptionItemStates.FAILED
  return ReceptionItemStates.PENDING
}

// Only a batch that waits for scans or fixes can change, and only a package not received yet can be edited or removed
export function isBatchOpen(status: ReceptionBatchStatus): boolean {
  return EDITABLE_STATUSES.includes(status)
}

export function isItemEditable(item: Pick<ReceptionItemView, 'outcome'>): boolean {
  return itemStateOf(item) !== ReceptionItemStates.RECEIVED
}

// Closing the batch has something to do while any package is not received
export function hasWorkLeft(items: readonly Pick<ReceptionItemView, 'outcome'>[]): boolean {
  return items.some(isItemEditable)
}

// What the editor of one package holds, as plain values
export interface ReceptionItemDraft {
  reason: string
  condition: OrderReturnCondition
  note: string
  flagCustomer: boolean
  flagReason: string
}

export function itemDraftOf(item: ReceptionItemView): ReceptionItemDraft {
  return {
    reason: item.reason,
    condition: item.condition,
    note: item.note ?? '',
    flagCustomer: item.flagCustomer,
    flagReason: item.flagReason ?? ''
  }
}

// A flag needs a line about the person: the one typed or, failing it, the note of the package
export function flagIsMissingReason(draft: ReceptionItemDraft): boolean {
  return draft.flagCustomer && draft.flagReason.trim() === '' && draft.note.trim() === ''
}

// Only what the agent changed (null is nothing to send). A key never touched must not overwrite what a refusal preselected.
export function itemChanges(
  item: ReceptionItemView,
  draft: ReceptionItemDraft
): UpdateReceptionItemBody | null {
  const body: UpdateReceptionItemBody = {}
  // A reason the screen does not know (a newer api) is never sent back
  const reason = asReturnReasonKey(draft.reason)
  if (draft.reason !== item.reason && reason !== null) body.reason = reason
  if (draft.condition !== item.condition) body.condition = draft.condition
  const note = draft.note.trim()
  if (note !== (item.note ?? '')) body.note = note === '' ? null : note
  if (draft.flagCustomer !== item.flagCustomer) body.flagCustomer = draft.flagCustomer
  const flagReason = draft.flagReason.trim()
  if (draft.flagCustomer && flagReason !== (item.flagReason ?? '')) {
    body.flagReason = flagReason === '' ? null : flagReason
  }
  return Object.keys(body).length > 0 ? body : null
}
