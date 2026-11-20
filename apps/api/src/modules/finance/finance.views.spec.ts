import {
  balanceView,
  entryView,
  isoDay,
  periodView,
  settingsView,
  taxRateView
} from './finance.views'

describe('isoDay', () => {
  it('is the accounting day of a DATE column, whatever the time zone of the server', () => {
    expect(isoDay(new Date('2026-11-10T00:00:00Z'))).toBe('2026-11-10')
  })
})

describe('balanceView', () => {
  it('counts a balance on the side where the account grows, in a string that holds more than 32 bits', () => {
    const big = 5_000_000_000n

    expect(
      balanceView({ accountId: 'a', normalSide: 'debit', debitCents: big, creditCents: 100n })
    ).toEqual({
      accountId: 'a',
      debitCents: '5000000000',
      creditCents: '100',
      balanceCents: '4999999900'
    })
    expect(
      balanceView({ accountId: 'b', normalSide: 'credit', debitCents: 100n, creditCents: big })
        .balanceCents
    ).toBe('4999999900')
    expect(
      balanceView({ accountId: 'c', normalSide: 'credit', debitCents: 100n, creditCents: 0n })
        .balanceCents
    ).toBe('-100')
  })
})

describe('entryView', () => {
  it('shows the number as a string and the derived reversal', () => {
    const view = entryView(
      {
        id: 'e',
        number: 9_007_199_254_740_993n,
        entryDate: new Date('2026-11-10T00:00:00Z'),
        periodId: 'p',
        type: 'manual',
        sourceType: null,
        sourceId: null,
        sourceDate: null,
        idempotencyKey: 'manual:key',
        reversesEntryId: null,
        memo: null,
        currency: 'USD',
        totalCents: 5,
        createdBy: 'u',
        origin: 'user',
        createdAt: new Date('2026-11-10T12:00:00Z'),
        prevHash: null,
        hash: 'h'
      },
      'r'
    )

    expect(view.number).toBe('9007199254740993')
    expect(view.entryDate).toBe('2026-11-10')
    expect(view.reversedByEntryId).toBe('r')
    // The key of a request is the screen's secret of retry, not something the journal shows
    expect(Object.keys(view)).not.toContain('idempotencyKey')
  })
})

describe('settingsView', () => {
  it('has no counter and no head of the chain: they move with an entry and are not a setting', () => {
    const view = settingsView({
      countryCode: 'SV',
      baseCurrency: 'USD',
      accountingStartDate: new Date('2026-01-01T00:00:00Z'),
      lockedThrough: null,
      recognizeSaleOn: 'delivered',
      roundingAccountId: null,
      taxRounding: 'half_up',
      shippingTaxed: true,
      updatedAt: new Date('2026-01-01T00:00:00Z')
    })

    expect(view.lockedThrough).toBeNull()
    expect([view.taxRounding, view.shippingTaxed]).toEqual(['half_up', true])
    expect(Object.keys(view)).not.toContain('nextEntryNumber')
  })
})

describe('taxRateView', () => {
  it('shows the rate as basis points and the dates as instants, with the accounts it posts to', () => {
    const view = taxRateView({
      id: 't',
      code: 'IVA',
      name: 'IVA 13 %',
      rateBps: 1300,
      kind: 'vat',
      outputAccountId: 'o',
      inputAccountId: 'i',
      active: true,
      isDefault: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z')
    })

    expect(view.rateBps).toBe(1300)
    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect([view.outputAccountId, view.inputAccountId, view.isDefault]).toEqual(['o', 'i', true])
  })
})

describe('periodView', () => {
  const row = {
    id: 'p',
    year: 2026,
    month: 9,
    startsOn: new Date('2026-09-01T00:00:00Z'),
    endsOn: new Date('2026-09-30T00:00:00Z'),
    status: 'open',
    closedAt: null,
    closedBy: null,
    reopenedAt: null,
    reopenedBy: null,
    reopenReason: null,
    closingHash: null
  }

  it('says a month has ended only from the day after its last one, in the day it is given', () => {
    expect(periodView(row, '2026-09-30').hasEnded).toBe(false)
    expect(periodView(row, '2026-10-01').hasEnded).toBe(true)
  })

  it('gives the head of the chain frozen at the close, for the auditor (TDD_18 §5.1), and null for a month never closed', () => {
    expect(periodView(row, '2026-10-01').closingHash).toBeNull()
    const hash = 'a'.repeat(64)
    expect(
      periodView({ ...row, status: 'closed', closingHash: hash }, '2026-10-01').closingHash
    ).toBe(hash)
  })

  it('says a month has started from its first day', () => {
    expect(periodView(row, '2026-08-31').hasStarted).toBe(false)
    expect(periodView(row, '2026-09-01').hasStarted).toBe(true)
  })
})
