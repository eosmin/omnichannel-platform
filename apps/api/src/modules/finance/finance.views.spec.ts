import { balanceView, entryView, isoDay, settingsView } from './finance.views'

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
      updatedAt: new Date('2026-01-01T00:00:00Z')
    })

    expect(view.lockedThrough).toBeNull()
    expect(Object.keys(view)).not.toContain('nextEntryNumber')
  })
})
