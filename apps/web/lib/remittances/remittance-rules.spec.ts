import type { RemittanceDetailView, RemittanceLineView } from '@platform/api-client'
import {
  ProductLimits,
  RemittanceLimits,
  RemittanceLineOutcome,
  RemittanceStatus
} from '@platform/core/domain'

import {
  isOverdue,
  isSettling,
  lineEditBody,
  mayConfirm,
  outcomeCounts,
  outcomeTone,
  parseAmountInput,
  pendingSummary,
  unsettledCount
} from './remittance-rules'

const line = (overrides: Partial<RemittanceLineView> = {}): RemittanceLineView => ({
  id: 'l1',
  position: 1,
  guideNumber: 'G-1',
  shipmentId: 's1',
  orderNumber: '1001',
  reportedCents: 1500,
  reportedFeeCents: null,
  expectedCents: 1500,
  differenceCents: 0,
  outcome: RemittanceLineOutcome.MATCHED,
  excluded: false,
  note: null,
  ...overrides
})

const remittance = (
  lines: RemittanceLineView[],
  status: RemittanceStatus = RemittanceStatus.DRAFT
): RemittanceDetailView => ({
  id: 'r1',
  connectionId: 'c1',
  connectionName: 'Carrier',
  carrierId: 'x',
  status,
  reference: null,
  receivedOn: null,
  importProfileId: null,
  sourceMediaId: null,
  totals: { expectedCents: 0, reportedCents: 0, feeCents: 0, differenceCents: 0 },
  lineCount: lines.length,
  note: null,
  createdBy: 'u1',
  createdAt: '2026-11-12T00:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  lines
})

describe('outcomeTone', () => {
  it('is quiet for a match, a warning for a difference and a problem for a line with no shipment', () => {
    expect(outcomeTone(RemittanceLineOutcome.MATCHED)).toBe('ok')
    expect(outcomeTone(RemittanceLineOutcome.AMOUNT_DIFFERS)).toBe('warning')
    expect(outcomeTone(RemittanceLineOutcome.ALREADY_REMITTED)).toBe('warning')
    expect(outcomeTone(RemittanceLineOutcome.NOT_FOUND)).toBe('problem')
    expect(outcomeTone(RemittanceLineOutcome.DUPLICATE_IN_FILE)).toBe('problem')
    expect(outcomeTone(RemittanceLineOutcome.NOT_DELIVERED)).toBe('problem')
  })
})

describe('settling and confirming', () => {
  it('settles matched lines and lines with a different amount, unless left out', () => {
    expect(isSettling(line())).toBe(true)
    expect(isSettling(line({ outcome: RemittanceLineOutcome.AMOUNT_DIFFERS }))).toBe(true)
    expect(isSettling(line({ excluded: true }))).toBe(false)
    expect(isSettling(line({ outcome: RemittanceLineOutcome.NOT_FOUND }))).toBe(false)
  })

  it('confirms only a draft with something to settle', () => {
    expect(mayConfirm(remittance([line()]))).toBe(true)
    expect(mayConfirm(remittance([]))).toBe(false)
    expect(mayConfirm(remittance([line({ excluded: true })]))).toBe(false)
    expect(mayConfirm(remittance([line()], RemittanceStatus.CONFIRMED))).toBe(false)
  })

  it('counts the lines kept that settle nothing, and every outcome without the lines left out', () => {
    const lines = [
      line(),
      line({ id: 'l2', outcome: RemittanceLineOutcome.NOT_FOUND }),
      line({ id: 'l3', outcome: RemittanceLineOutcome.NOT_FOUND, excluded: true })
    ]
    expect(unsettledCount(remittance(lines))).toBe(1)
    const counts = outcomeCounts(lines)
    expect(counts[RemittanceLineOutcome.MATCHED]).toBe(1)
    expect(counts[RemittanceLineOutcome.NOT_FOUND]).toBe(1)
    expect(counts[RemittanceLineOutcome.DUPLICATE_IN_FILE]).toBe(0)
  })
})

describe('parseAmountInput', () => {
  it('reads an amount as whole cents and refuses anything else', () => {
    expect(parseAmountInput('15')).toBe(1500)
    expect(parseAmountInput('15.50')).toBe(1550)
    expect(parseAmountInput('15,5')).toBe(1550)
    expect(parseAmountInput('')).toBeNull()
    expect(parseAmountInput('abc')).toBeNull()
    expect(parseAmountInput('-1')).toBeNull()
    expect(parseAmountInput('1.234')).toBeNull()
  })

  it('refuses more than a line takes', () => {
    const limit = RemittanceLimits.MAX_AMOUNT_CENTS
    expect(parseAmountInput(String(limit / 100))).toBe(limit)
    expect(parseAmountInput(`${limit / 100}.01`)).toBeNull()
  })

  it('is never stricter than the catalog parser it reads with', () => {
    // parseAmountInput reads through the catalog's parser: its own limit must not cut a remittance amount the api takes
    expect(ProductLimits.MAX_AMOUNT_CENTS).toBeGreaterThanOrEqual(RemittanceLimits.MAX_AMOUNT_CENTS)
  })
})

describe('lineEditBody', () => {
  const same = { reported: '15.00', fee: '', note: '', excluded: false }

  it('says nothing changed when the form is the line', () => {
    expect(lineEditBody(line(), same)).toEqual({ ok: true, body: null })
  })

  it('sends only what changed', () => {
    expect(lineEditBody(line(), { ...same, reported: '12.25' })).toEqual({
      ok: true,
      body: { reportedCents: 1225 }
    })
    expect(lineEditBody(line(), { ...same, excluded: true })).toEqual({
      ok: true,
      body: { excluded: true }
    })
    expect(lineEditBody(line(), { ...same, note: ' checked ' })).toEqual({
      ok: true,
      body: { note: 'checked' }
    })
  })

  it('takes a fee back with an empty field and sets it with an amount', () => {
    expect(lineEditBody(line({ reportedFeeCents: 100 }), same)).toEqual({
      ok: true,
      body: { reportedFeeCents: null }
    })
    expect(lineEditBody(line(), { ...same, fee: '1.5' })).toEqual({
      ok: true,
      body: { reportedFeeCents: 150 }
    })
  })

  it('refuses a bad amount even when the line is being left out', () => {
    expect(lineEditBody(line(), { ...same, reported: 'x', excluded: true })).toEqual({
      ok: false,
      field: 'reported'
    })
  })

  it('names the field that is not an amount and never reads it as zero', () => {
    expect(lineEditBody(line(), { ...same, reported: 'abc' })).toEqual({
      ok: false,
      field: 'reported'
    })
    expect(lineEditBody(line(), { ...same, reported: '' })).toEqual({
      ok: false,
      field: 'reported'
    })
    expect(lineEditBody(line(), { ...same, fee: 'x' })).toEqual({ ok: false, field: 'fee' })
  })
})

describe('pending', () => {
  const connection = (totalOwedCents: number, count: number, oldestAgeDays: number | null) => ({
    connectionId: 'c',
    connectionName: 'C',
    carrierId: 'x',
    count,
    totalOwedCents,
    oldestDeliveredAt: null,
    oldestAgeDays,
    shipments: [],
    truncated: false
  })

  it('adds what is owed with its sign and keeps the oldest age', () => {
    expect(pendingSummary([connection(5000, 2, 3), connection(-1000, 1, 9)])).toEqual({
      totalOwedCents: 4000,
      count: 3,
      oldestAgeDays: 9
    })
    expect(pendingSummary([])).toEqual({ totalOwedCents: 0, count: 0, oldestAgeDays: null })
  })

  it('warns of a delay only when the threshold is known and passed', () => {
    expect(isOverdue(8, 7)).toBe(true)
    expect(isOverdue(7, 7)).toBe(false)
    expect(isOverdue(null, 7)).toBe(false)
    expect(isOverdue(30, null)).toBe(false)
  })
})
