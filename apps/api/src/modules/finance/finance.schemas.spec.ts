import { JournalEntryType, PaymentMethod } from '@platform/core/domain'

import {
  listEntriesQuerySchema,
  manualEntrySchema,
  openPeriodSchema,
  reverseEntrySchema,
  setPaymentAccountSchema,
  setupSchema,
  updateAccountSchema,
  updateSettingsSchema
} from './finance.schemas'

const ID = '8a1c5f1e-3f55-4c28-93cc-0e2d4ff1c7a1'
const OTHER = '5d3cf0f6-9b1f-4c52-8b57-2f1c7f8cbb02'

const entry = (extra: Record<string, unknown> = {}) => ({
  idempotencyKey: 'a-key-of-the-screen',
  entryDate: '2026-11-10',
  type: JournalEntryType.MANUAL,
  memo: 'Why',
  lines: [
    { accountId: ID, debitCents: 100 },
    { accountId: OTHER, creditCents: 100 }
  ],
  ...extra
})

describe('manualEntrySchema', () => {
  it('takes a balanced shape with the amounts defaulting to zero', () => {
    const parsed = manualEntrySchema.parse(entry())

    expect(parsed.lines.map(line => [line.debitCents, line.creditCents])).toEqual([
      [100, 0],
      [0, 100]
    ])
  })

  it.each([
    ['no reason', { memo: '  ' }],
    ['a date that is not a day', { entryDate: '2026-02-30' }],
    ['a type the screen does not post', { type: JournalEntryType.SALE }],
    ['a short key', { idempotencyKey: 'short' }],
    ['a key with a space', { idempotencyKey: 'has a space in it' }],
    ['one line', { lines: [{ accountId: ID, debitCents: 1 }] }],
    [
      'more lines than an entry holds',
      { lines: Array.from({ length: 201 }, () => ({ accountId: ID, debitCents: 1 })) }
    ],
    [
      'a fraction of a cent',
      {
        lines: [
          { accountId: ID, debitCents: 1.5 },
          { accountId: OTHER, creditCents: 1.5 }
        ]
      }
    ],
    [
      'a negative amount',
      {
        lines: [
          { accountId: ID, debitCents: -1 },
          { accountId: OTHER, creditCents: -1 }
        ]
      }
    ],
    [
      'more than an Int of the database',
      {
        lines: [
          { accountId: ID, debitCents: 2_147_483_648 },
          { accountId: OTHER, creditCents: 2_147_483_648 }
        ]
      }
    ],
    [
      'a party',
      {
        lines: [
          { accountId: ID, debitCents: 1, partyType: 'supplier', partyId: OTHER },
          { accountId: OTHER, creditCents: 1 }
        ]
      }
    ],
    [
      'a tax rate',
      {
        lines: [
          { accountId: ID, debitCents: 1, taxRateId: OTHER },
          { accountId: OTHER, creditCents: 1 }
        ]
      }
    ],
    ['an origin', { origin: 'system' }],
    ['an organization', { organizationId: ID }]
  ])('refuses %s', (_name, extra) => {
    expect(manualEntrySchema.safeParse(entry(extra)).success).toBe(false)
  })

  it('takes an opening balance too', () => {
    expect(
      manualEntrySchema.safeParse(entry({ type: JournalEntryType.OPENING_BALANCE })).success
    ).toBe(true)
  })
})

describe('reverseEntrySchema', () => {
  it('needs the reason and takes a date', () => {
    expect(reverseEntrySchema.safeParse({}).success).toBe(false)
    expect(reverseEntrySchema.safeParse({ memo: 'Why', entryDate: '2026-12-01' }).success).toBe(
      true
    )
    expect(reverseEntrySchema.safeParse({ memo: 'Why', entryDate: '2026-13-01' }).success).toBe(
      false
    )
  })
})

describe('the setup and the settings', () => {
  it('knows the countries that have a template, and no other field', () => {
    expect(setupSchema.safeParse({ countryCode: 'SV' }).success).toBe(true)
    expect(setupSchema.safeParse({ countryCode: 'XX' }).success).toBe(false)
    expect(setupSchema.safeParse({ countryCode: 'SV', organizationId: ID }).success).toBe(false)
  })

  it('changes something or nothing at all, never the start of the books', () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(false)
    expect(updateSettingsSchema.safeParse({ recognizeSaleOn: 'shipped' }).success).toBe(true)
    expect(updateSettingsSchema.safeParse({ roundingAccountId: ID }).success).toBe(true)
    expect(updateSettingsSchema.safeParse({ roundingAccountId: null }).success).toBe(false)
    expect(updateSettingsSchema.safeParse({ recognizeSaleOn: 'whenever' }).success).toBe(false)
    expect(updateSettingsSchema.safeParse({ accountingStartDate: '2026-01-01' }).success).toBe(
      false
    )
  })
})

describe('the chart and the maps', () => {
  it("keeps an account code to the accountant's alphabet", () => {
    expect(updateAccountSchema.safeParse({ code: '1101.01' }).success).toBe(true)
    expect(updateAccountSchema.safeParse({ code: 'has space' }).success).toBe(false)
    expect(updateAccountSchema.safeParse({ code: '' }).success).toBe(false)
    expect(updateAccountSchema.safeParse({}).success).toBe(false)
  })

  it('sends collect on delivery nowhere: it has no account of its own', () => {
    const body = (paymentMethod: string) => ({ paymentMethod, accountId: ID })

    expect(setPaymentAccountSchema.safeParse(body(PaymentMethod.CASH)).success).toBe(true)
    expect(setPaymentAccountSchema.safeParse(body(PaymentMethod.CASH_ON_DELIVERY)).success).toBe(
      false
    )
  })
})

describe('the periods and the lists', () => {
  it('keeps a period to a real month of a sane year', () => {
    expect(openPeriodSchema.safeParse({ year: 2026, month: 12 }).success).toBe(true)
    expect(openPeriodSchema.safeParse({ year: 2026, month: 13 }).success).toBe(false)
    expect(openPeriodSchema.safeParse({ year: 1999, month: 1 }).success).toBe(false)
  })

  it('reads the cursor of the journal as a number and refuses anything else', () => {
    expect(listEntriesQuerySchema.safeParse({ cursor: '120' }).success).toBe(true)
    expect(listEntriesQuerySchema.safeParse({ cursor: '0' }).success).toBe(false)
    expect(listEntriesQuerySchema.safeParse({ cursor: '1; drop table' }).success).toBe(false)
    expect(listEntriesQuerySchema.safeParse({ organizationId: ID }).success).toBe(false)
  })
})
