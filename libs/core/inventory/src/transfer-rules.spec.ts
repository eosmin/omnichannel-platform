import {
  TransferMovementKeys,
  TransferShortageAction,
  TransferStatus,
  TransferStatusTransitions
} from '@platform/core/domain'

import {
  canMoveTransfer,
  formatTransferNumber,
  pendingOf,
  planClose,
  planReceipt,
  transferMovementKey,
  transferSequence
} from './transfer-rules'

const lines = [
  { id: 'a', quantity: 10, receivedQuantity: 0 },
  { id: 'b', quantity: 4, receivedQuantity: 4 },
  { id: 'c', quantity: 6, receivedQuantity: 2 }
]

describe('canMoveTransfer', () => {
  it('follows the table of TDD_16 §3 for every pair of statuses', () => {
    for (const from of Object.values(TransferStatus)) {
      for (const to of Object.values(TransferStatus)) {
        expect(canMoveTransfer(from, to)).toBe(TransferStatusTransitions[from].includes(to))
      }
    }
  })

  it('lets nothing leave a received or a cancelled transfer, and no transfer go back to draft', () => {
    for (const to of Object.values(TransferStatus)) {
      expect(canMoveTransfer(TransferStatus.RECEIVED, to)).toBe(false)
      expect(canMoveTransfer(TransferStatus.CANCELLED, to)).toBe(false)
      expect(canMoveTransfer(to, TransferStatus.DRAFT)).toBe(false)
    }
    expect(canMoveTransfer(TransferStatus.DRAFT, TransferStatus.RECEIVED)).toBe(false)
  })
})

describe('the number of a transfer', () => {
  it('is padded to four digits and only grows past them', () => {
    expect(formatTransferNumber(1)).toBe('TR-0001')
    expect(formatTransferNumber(9999)).toBe('TR-9999')
    expect(formatTransferNumber(10000)).toBe('TR-10000')
  })

  it('reads its sequence back, and refuses a text that is not a number', () => {
    expect(transferSequence('TR-0042')).toBe(42)
    expect(transferSequence('TR-10000')).toBe(10000)
    expect(transferSequence('OR-0042')).toBeNull()
    expect(transferSequence('TR-')).toBeNull()
    expect(transferSequence('TR-12a')).toBeNull()
    expect(transferSequence('TR-99999999999999999999')).toBeNull()
  })
})

describe('transferMovementKey', () => {
  it('names the transfer, the line and the step, and a receipt adds its own key', () => {
    expect(transferMovementKey('t', 'l', TransferMovementKeys.DISPATCH)).toBe(
      'transfer:t:l:dispatch'
    )
    expect(transferMovementKey('t', 'l', TransferMovementKeys.RECEIVE, 'r1')).toBe(
      'transfer:t:l:receive:r1'
    )
  })
})

describe('planReceipt', () => {
  it('takes what is pending of a line and says what the line holds after it', () => {
    const plan = planReceipt(lines, [{ lineId: 'a', quantity: 3 }])
    expect(plan).toEqual({
      ok: true,
      receipts: [{ lineId: 'a', quantity: 3, receivedAfter: 3 }],
      completes: false
    })
  })

  it('completes the transfer only when every line has all its units after the receipt', () => {
    const plan = planReceipt(lines, [
      { lineId: 'a', quantity: 10 },
      { lineId: 'c', quantity: 4 }
    ])
    expect(plan).toMatchObject({ ok: true, completes: true })
    const partial = planReceipt(lines, [
      { lineId: 'a', quantity: 10 },
      { lineId: 'c', quantity: 3 }
    ])
    expect(partial).toMatchObject({ ok: true, completes: false })
  })

  it('refuses more than is pending, counting what already arrived', () => {
    expect(planReceipt(lines, [{ lineId: 'c', quantity: 5 }])).toEqual({
      ok: false,
      refusal: { kind: 'exceeds_dispatched', lineId: 'c', pending: 4 }
    })
    expect(planReceipt(lines, [{ lineId: 'b', quantity: 1 }])).toEqual({
      ok: false,
      refusal: { kind: 'exceeds_dispatched', lineId: 'b', pending: 0 }
    })
  })

  it('refuses an empty receipt, a line that is not of the transfer, a line twice and a quantity that is not whole', () => {
    expect(planReceipt(lines, [])).toEqual({ ok: false, refusal: { kind: 'empty' } })
    expect(planReceipt(lines, [{ lineId: 'zzz', quantity: 1 }])).toEqual({
      ok: false,
      refusal: { kind: 'unknown_line', lineId: 'zzz' }
    })
    expect(
      planReceipt(lines, [
        { lineId: 'a', quantity: 1 },
        { lineId: 'a', quantity: 1 }
      ])
    ).toEqual({ ok: false, refusal: { kind: 'duplicate_line', lineId: 'a' } })
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(planReceipt(lines, [{ lineId: 'a', quantity }])).toEqual({
        ok: false,
        refusal: { kind: 'invalid_quantity', lineId: 'a' }
      })
    }
  })
})

describe('planClose', () => {
  it('asks an action for each line that did not arrive in full, and for no other', () => {
    expect(
      planClose(lines, [
        { lineId: 'a', action: TransferShortageAction.WRITE_OFF },
        { lineId: 'c', action: TransferShortageAction.RETURN_TO_SOURCE }
      ])
    ).toEqual({
      ok: true,
      shortages: [
        { lineId: 'a', missing: 10, action: TransferShortageAction.WRITE_OFF },
        { lineId: 'c', missing: 4, action: TransferShortageAction.RETURN_TO_SOURCE }
      ]
    })
  })

  it('refuses a short line with no action, an action for a complete line, a line twice and an unknown line', () => {
    expect(planClose(lines, [{ lineId: 'a', action: TransferShortageAction.WRITE_OFF }])).toEqual({
      ok: false,
      refusal: { kind: 'missing_action', lineId: 'c' }
    })
    expect(
      planClose(lines, [
        { lineId: 'a', action: TransferShortageAction.WRITE_OFF },
        { lineId: 'b', action: TransferShortageAction.WRITE_OFF },
        { lineId: 'c', action: TransferShortageAction.WRITE_OFF }
      ])
    ).toEqual({ ok: false, refusal: { kind: 'no_shortage', lineId: 'b' } })
    expect(
      planClose(lines, [
        { lineId: 'a', action: TransferShortageAction.WRITE_OFF },
        { lineId: 'a', action: TransferShortageAction.RETURN_TO_SOURCE }
      ])
    ).toEqual({ ok: false, refusal: { kind: 'duplicate_line', lineId: 'a' } })
    expect(planClose(lines, [{ lineId: 'zzz', action: TransferShortageAction.WRITE_OFF }])).toEqual(
      { ok: false, refusal: { kind: 'unknown_line', lineId: 'zzz' } }
    )
  })
})

describe('pendingOf', () => {
  it('is what was dispatched minus what arrived', () => {
    expect(pendingOf({ id: 'x', quantity: 9, receivedQuantity: 4 })).toBe(5)
  })
})
