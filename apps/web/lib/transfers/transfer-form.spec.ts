import type { TransferLineView, TransferView } from '@platform/api-client'
import { InventoryLimits, TransferShortageAction, TransferStatus } from '@platform/core/domain'

import {
  actionsOf,
  addOneUnit,
  addToDraft,
  allPendingOf,
  closeInputOf,
  type DraftLine,
  draftChanged,
  draftInputOf,
  draftLineKey,
  draftLinesOf,
  lineOfCode,
  linesMatching,
  parseQuantity,
  receiptOf,
  shortLinesOf
} from './transfer-form'

const line = (over: Partial<TransferLineView> = {}): TransferLineView => ({
  id: 'l1',
  storeId: 's1',
  productId: 'p1',
  productName: 'Shoe',
  variantId: null,
  variantName: null,
  sku: 'SHOE-1',
  quantity: 5,
  receivedQuantity: 2,
  pendingQuantity: 3,
  shortageAction: null,
  ...over
})

const transfer = (lines: TransferLineView[]): TransferView => ({
  id: 't1',
  number: 'TR-0001',
  status: TransferStatus.DRAFT,
  fromWarehouse: { id: 'w1', name: 'Main', code: 'MAIN' },
  toWarehouse: { id: 'w2', name: 'Outlet', code: 'OUT' },
  note: null,
  createdBy: 'u1',
  dispatchedBy: null,
  dispatchedAt: null,
  closedAt: null,
  createdAt: '2026-11-11T10:00:00.000Z',
  updatedAt: '2026-11-11T10:00:00.000Z',
  lines
})

describe('parseQuantity', () => {
  it('takes whole units from 1 up to the most a movement holds', () => {
    expect(parseQuantity('12')).toBe(12)
    expect(parseQuantity(' 7 ')).toBe(7)
    expect(parseQuantity(String(InventoryLimits.MAX_MOVEMENT_QUANTITY))).toBe(
      InventoryLimits.MAX_MOVEMENT_QUANTITY
    )
  })

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    '1,5',
    'a',
    String(InventoryLimits.MAX_MOVEMENT_QUANTITY + 1),
    '1e3'
  ])('refuses "%s"', text => {
    expect(parseQuantity(text)).toBeNull()
  })
})

describe('the draft', () => {
  const shoe: DraftLine = {
    key: draftLineKey('p1', null),
    storeId: 's1',
    productId: 'p1',
    variantId: null,
    productName: 'Shoe',
    variantName: null,
    sku: 'SHOE-1',
    quantity: '3'
  }

  it('starts from the lines of the transfer', () => {
    const lines = draftLinesOf(transfer([line({ variantId: 'v1', variantName: 'Red' })]))
    expect(lines).toEqual([
      expect.objectContaining({ key: 'p1:v1', variantId: 'v1', variantName: 'Red', quantity: '5' })
    ])
  })

  it('adds an item already in the draft to its line, and caps it', () => {
    expect(addToDraft([shoe], { ...shoe, quantity: '4' })[0]?.quantity).toBe('7')
    expect(
      addToDraft([{ ...shoe, quantity: '999999' }], { ...shoe, quantity: '10' })[0]?.quantity
    ).toBe('1000000')
    expect(addToDraft([shoe], { ...shoe, key: 'p2:', productId: 'p2' })).toHaveLength(2)
  })

  it('sends the variant only when the item has one', () => {
    const result = draftInputOf([shoe, { ...shoe, key: 'p2:v2', productId: 'p2', variantId: 'v2' }])
    expect(result).toEqual({
      ok: true,
      lines: [
        { productId: 'p1', quantity: 3 },
        { productId: 'p2', variantId: 'v2', quantity: 3 }
      ]
    })
  })

  it('names the first line whose quantity is not whole units', () => {
    expect(draftInputOf([shoe, { ...shoe, key: 'x', quantity: '1.5' }])).toEqual({
      ok: false,
      wrongKey: 'x'
    })
  })

  it('knows whether the lines on screen differ from the saved ones', () => {
    const saved = transfer([line({ quantity: 3 })])
    expect(draftChanged([shoe], saved)).toBe(false)
    expect(draftChanged([{ ...shoe, quantity: ' 3 ' }], saved)).toBe(false)
    expect(draftChanged([{ ...shoe, quantity: '03' }], saved)).toBe(false)
    expect(draftChanged([{ ...shoe, quantity: '4' }], saved)).toBe(true)
    expect(draftChanged([], saved)).toBe(true)
    expect(draftChanged([{ ...shoe, key: 'p9:', productId: 'p9' }], saved)).toBe(true)
  })
})

describe('the receipt', () => {
  const lines = [
    line({ id: 'a', pendingQuantity: 3 }),
    line({ id: 'b', pendingQuantity: 0, receivedQuantity: 5 }),
    line({ id: 'c', pendingQuantity: 2, sku: 'BAG-9', productName: 'Bag' })
  ]

  it('offers to take in everything that is still on its way', () => {
    expect(allPendingOf(lines)).toEqual({ a: '3', c: '2' })
  })

  it('sends the lines with units and leaves the empty boxes out', () => {
    expect(receiptOf(lines, { a: '2', c: '' })).toEqual({
      ok: true,
      lines: [{ lineId: 'a', quantity: 2 }]
    })
    expect(receiptOf(lines, { a: '0', c: '2' })).toEqual({
      ok: true,
      lines: [{ lineId: 'c', quantity: 2 }]
    })
  })

  it('refuses more than what is pending, a fraction, and an empty receipt', () => {
    expect(receiptOf(lines, { a: '4' })).toEqual({ ok: false, wrongLineId: 'a' })
    expect(receiptOf(lines, { a: '1.5' })).toEqual({ ok: false, wrongLineId: 'a' })
    expect(receiptOf(lines, { b: '1' })).toEqual({ ok: false, wrongLineId: 'b' })
    expect(receiptOf(lines, {})).toEqual({ ok: false, wrongLineId: null })
  })

  it('adds one unit at a time and stops at what is pending', () => {
    const first = addOneUnit(lines[2] as TransferLineView, {})
    expect(first).toEqual({ c: '1' })
    const second = addOneUnit(lines[2] as TransferLineView, first)
    const third = addOneUnit(lines[2] as TransferLineView, second)
    expect(third).toEqual({ c: '2' })
  })

  it('finds the line of a scanned code, whatever its case, preferring one with units to come', () => {
    expect(lineOfCode(lines, ' bag-9 ')?.id).toBe('c')
    expect(lineOfCode(lines, 'nope')).toBeNull()
    expect(lineOfCode(lines, '')).toBeNull()
    const twins = [line({ id: 'x', pendingQuantity: 0 }), line({ id: 'y', pendingQuantity: 1 })]
    expect(lineOfCode(twins, 'SHOE-1')?.id).toBe('y')
    expect(lineOfCode([twins[0] as TransferLineView], 'SHOE-1')?.id).toBe('x')
  })

  it('searches by name, variant and SKU', () => {
    expect(linesMatching(lines, 'bag').map(item => item.id)).toEqual(['c'])
    expect(linesMatching(lines, 'shoe-1').map(item => item.id)).toEqual(['a', 'b'])
    expect(linesMatching(lines, '  ')).toHaveLength(3)
  })
})

describe('closing with a shortage', () => {
  const lines = [line({ id: 'a', pendingQuantity: 3 }), line({ id: 'b', pendingQuantity: 0 })]

  it('lists the lines that did not arrive in full', () => {
    expect(shortLinesOf(lines).map(item => item.id)).toEqual(['a'])
  })

  it('needs a choice for each short line, and only for those', () => {
    expect(closeInputOf(lines, {})).toBeNull()
    expect(
      closeInputOf(lines, {
        a: TransferShortageAction.RETURN_TO_SOURCE,
        b: TransferShortageAction.WRITE_OFF
      })
    ).toEqual([{ lineId: 'a', action: 'return_to_source' }])
  })
})

describe('what each status allows', () => {
  const all = { manage: true, receive: true }

  it('lets a draft be edited, sent or cancelled by who manages transfers', () => {
    expect(actionsOf(TransferStatus.DRAFT, all)).toEqual({
      edit: true,
      dispatch: true,
      receive: false,
      close: false,
      cancel: true
    })
    expect(actionsOf(TransferStatus.DRAFT, { manage: false, receive: true })).toEqual({
      edit: false,
      dispatch: false,
      receive: false,
      close: false,
      cancel: false
    })
  })

  it('lets one on its way be received and closed by who receives, and cancelled by who manages', () => {
    expect(actionsOf(TransferStatus.IN_TRANSIT, all)).toEqual({
      edit: false,
      dispatch: false,
      receive: true,
      close: true,
      cancel: true
    })
    expect(actionsOf(TransferStatus.IN_TRANSIT, { manage: false, receive: true })).toMatchObject({
      receive: true,
      close: true,
      cancel: false
    })
  })

  it('allows nothing once it is received or cancelled', () => {
    for (const status of [TransferStatus.RECEIVED, TransferStatus.CANCELLED]) {
      expect(Object.values(actionsOf(status, all))).toEqual([false, false, false, false, false])
    }
  })
})
