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
  decidesFlag,
  draftAfterReasonChange,
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

describe('the flag a refusal preselects', () => {
  const ticked = { preselects: true, mayFlag: true }

  it('ticks the box when the reason becomes a refusal and the server will preselect it', () => {
    const current = item()
    const next = draftAfterReasonChange(
      current,
      itemDraftOf(current),
      ReceptionReasons.REFUSED,
      ticked
    )
    expect(next.reason).toBe(ReceptionReasons.REFUSED)
    expect(next.flagCustomer).toBe(true)
  })

  it('leaves the box alone when the store does not ask, the reader may not flag, or the package was already a refusal', () => {
    const current = item()
    const draft = itemDraftOf(current)
    for (const options of [
      { preselects: false, mayFlag: true },
      { preselects: true, mayFlag: false }
    ]) {
      expect(
        draftAfterReasonChange(current, draft, ReceptionReasons.REFUSED, options).flagCustomer
      ).toBe(false)
    }
    const refused = item({ reason: ReceptionReasons.REFUSED })
    expect(
      draftAfterReasonChange(refused, itemDraftOf(refused), ReceptionReasons.REFUSED, ticked)
        .flagCustomer
    ).toBe(false)
  })

  it('goes back to the saved flag when the agent leaves the refusal again', () => {
    const current = item()
    const refused = draftAfterReasonChange(
      current,
      itemDraftOf(current),
      ReceptionReasons.REFUSED,
      ticked
    )
    const back = draftAfterReasonChange(current, refused, ReceptionReasons.DEFAULT, ticked)
    expect(back.flagCustomer).toBe(false)
    expect(back.reason).toBe(ReceptionReasons.DEFAULT)
  })

  it('sends the choice when the agent unticks it, because a silent body would be preselected by the server', () => {
    const current = item()
    const refused = draftAfterReasonChange(
      current,
      itemDraftOf(current),
      ReceptionReasons.REFUSED,
      ticked
    )
    // Left ticked: said too (it differs from the saved one), which is what the server would have done itself
    expect(itemChanges(current, refused, true)).toEqual({
      reason: ReceptionReasons.REFUSED,
      flagCustomer: true
    })
    // Unticked: said out loud, or the server would tick it
    expect(itemChanges(current, { ...refused, flagCustomer: false }, true)).toEqual({
      reason: ReceptionReasons.REFUSED,
      flagCustomer: false
    })
    // Without the preselection the unticked box is simply no change
    expect(itemChanges(current, { ...refused, flagCustomer: false }, false)).toEqual({
      reason: ReceptionReasons.REFUSED
    })
  })
})

describe('decidesFlag', () => {
  it('does not count the flag a refusal ticked by itself, so the package can be saved with nothing to say', () => {
    const current = item()
    const refused = draftAfterReasonChange(
      current,
      itemDraftOf(current),
      ReceptionReasons.REFUSED,
      { preselects: true, mayFlag: true }
    )
    expect(decidesFlag(current, refused, true)).toBe(false)
    // The same tick without the preselection is the agent's own decision
    expect(decidesFlag(current, refused, false)).toBe(true)
    // Typing a line, or ticking by hand on another reason, is a decision
    expect(decidesFlag(current, { ...refused, flagReason: 'rude' }, true)).toBe(true)
    expect(decidesFlag(current, { ...itemDraftOf(current), flagCustomer: true }, true)).toBe(true)
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
