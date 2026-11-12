import type { ReceptionBatchSummaryView, ReceptionItemView } from '@platform/api-client'
import {
  OrderReturnCondition,
  ReceptionBatchStatus,
  ReceptionItemOutcome,
  ReceptionReasons
} from '@platform/core/domain'

import {
  flagIsMissingReason,
  hasWorkLeft,
  isBatchOpen,
  isItemEditable,
  itemChanges,
  itemDraftOf,
  itemStateOf,
  openBatchOf,
  ReceptionItemStates
} from './reception-form'

function batch(
  id: string,
  status: ReceptionBatchStatus,
  createdAt: string
): ReceptionBatchSummaryView {
  return {
    id,
    status,
    createdBy: 'u1',
    createdAt,
    completedAt: null,
    counts: { total: 0, received: 0, failed: 0, pending: 0 }
  }
}

function item(patch: Partial<ReceptionItemView> = {}): ReceptionItemView {
  return {
    id: 'i1',
    shipmentId: 's1',
    guideNumber: 'G1',
    shipmentStatus: 'returned' as ReceptionItemView['shipmentStatus'],
    orderId: 'o1',
    orderNumber: '00001',
    orderItems: [],
    customerIsCaution: false,
    reason: ReceptionReasons.DEFAULT,
    condition: OrderReturnCondition.RESELLABLE,
    note: null,
    lines: [],
    flagCustomer: false,
    flagReason: null,
    confirmDelivered: false,
    outcome: null,
    errorCode: null,
    returnId: null,
    flagApplied: false,
    scannedAt: '2026-11-12T10:00:00.000Z',
    ...patch
  }
}

describe('openBatchOf', () => {
  it('is null when every batch is history', () => {
    expect(
      openBatchOf([batch('a', ReceptionBatchStatus.COMPLETED, '2026-11-12T10:00:00.000Z')])
    ).toBeNull()
    expect(openBatchOf([])).toBeNull()
  })

  it('takes the newest batch that is a draft or ended with errors', () => {
    const found = openBatchOf([
      batch('old', ReceptionBatchStatus.DRAFT, '2026-11-10T10:00:00.000Z'),
      batch('done', ReceptionBatchStatus.COMPLETED, '2026-11-12T12:00:00.000Z'),
      {
        ...batch('new', ReceptionBatchStatus.COMPLETED_WITH_ERRORS, '2026-11-11T10:00:00.000Z'),
        counts: { total: 2, received: 1, failed: 1, pending: 0 }
      }
    ])
    expect(found?.id).toBe('new')
  })

  it('shows a batch being processed, but it takes no edits', () => {
    expect(
      openBatchOf([batch('p', ReceptionBatchStatus.PROCESSING, '2026-11-12T10:00:00.000Z')])?.id
    ).toBe('p')
    expect(isBatchOpen(ReceptionBatchStatus.PROCESSING)).toBe(false)
  })

  it('drops a batch that ended with errors once nothing is failed or pending', () => {
    const done = batch('e', ReceptionBatchStatus.COMPLETED_WITH_ERRORS, '2026-11-12T10:00:00.000Z')
    expect(openBatchOf([done])).toBeNull()
    expect(openBatchOf([{ ...done, counts: { ...done.counts, failed: 1 } }])?.id).toBe('e')
  })
})

describe('item states', () => {
  it('reads the outcome', () => {
    expect(itemStateOf(item())).toBe(ReceptionItemStates.PENDING)
    expect(itemStateOf(item({ outcome: ReceptionItemOutcome.FAILED }))).toBe(
      ReceptionItemStates.FAILED
    )
    expect(itemStateOf(item({ outcome: ReceptionItemOutcome.RECEIVED }))).toBe(
      ReceptionItemStates.RECEIVED
    )
  })

  it('edits a package until it is received', () => {
    expect(isItemEditable(item({ outcome: ReceptionItemOutcome.FAILED }))).toBe(true)
    expect(isItemEditable(item({ outcome: ReceptionItemOutcome.RECEIVED }))).toBe(false)
  })

  it('has work left while a package is not received', () => {
    expect(hasWorkLeft([])).toBe(false)
    expect(hasWorkLeft([item({ outcome: ReceptionItemOutcome.RECEIVED })])).toBe(false)
    expect(
      hasWorkLeft([item({ outcome: ReceptionItemOutcome.RECEIVED }), item({ outcome: null })])
    ).toBe(true)
  })
})

describe('itemChanges', () => {
  it('sends nothing when nothing changed', () => {
    const current = item()
    expect(itemChanges(current, itemDraftOf(current))).toBeNull()
  })

  it('sends only the keys that changed', () => {
    const current = item()
    const draft = {
      ...itemDraftOf(current),
      reason: ReceptionReasons.REFUSED,
      condition: OrderReturnCondition.DAMAGED
    }
    expect(itemChanges(current, draft)).toEqual({
      reason: ReceptionReasons.REFUSED,
      condition: OrderReturnCondition.DAMAGED
    })
  })

  it('trims the note and sends null for a note that was emptied', () => {
    const current = item({ note: 'box open' })
    expect(itemChanges(current, { ...itemDraftOf(current), note: '  ' })).toEqual({ note: null })
    expect(itemChanges(item(), { ...itemDraftOf(item()), note: ' torn ' })).toEqual({
      note: 'torn'
    })
  })

  it('sends the flag with its reason, and no reason when the flag is off', () => {
    const current = item()
    expect(
      itemChanges(current, {
        ...itemDraftOf(current),
        flagCustomer: true,
        flagReason: ' refused twice '
      })
    ).toEqual({ flagCustomer: true, flagReason: 'refused twice' })
    const flagged = item({ flagCustomer: true, flagReason: 'refused twice' })
    expect(
      itemChanges(flagged, { ...itemDraftOf(flagged), flagCustomer: false, flagReason: 'x' })
    ).toEqual({ flagCustomer: false })
  })
})

describe('flagIsMissingReason', () => {
  it('needs the line or the note once the flag is on', () => {
    const base = itemDraftOf(item())
    expect(flagIsMissingReason(base)).toBe(false)
    expect(flagIsMissingReason({ ...base, flagCustomer: true })).toBe(true)
    expect(flagIsMissingReason({ ...base, flagCustomer: true, note: 'box open' })).toBe(false)
    expect(flagIsMissingReason({ ...base, flagCustomer: true, flagReason: 'x' })).toBe(false)
  })
})
