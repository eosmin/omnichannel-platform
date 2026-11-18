import { randomUUID } from 'node:crypto'

import {
  accountBalancesQuerySchema,
  chainStatusQuerySchema,
  closePeriodSchema,
  journalCsvQuerySchema,
  journalQuerySchema,
  ledgerCsvQuerySchema,
  ledgerQuerySchema,
  reopenPeriodSchema,
  trialBalanceQuerySchema
} from './finance-reports.schemas'

describe('the reopen of a period', () => {
  it('takes a reason and nothing else', () => {
    expect(reopenPeriodSchema.safeParse({ reason: 'A correction' }).success).toBe(true)
    expect(reopenPeriodSchema.safeParse({ reason: 'A correction', extra: 1 }).success).toBe(false)
  })

  it('refuses an empty reason, one of spaces and one that is too long', () => {
    expect(reopenPeriodSchema.safeParse({ reason: '' }).success).toBe(false)
    expect(reopenPeriodSchema.safeParse({ reason: '   ' }).success).toBe(false)
    expect(reopenPeriodSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false)
  })

  it('refuses a reason on two lines', () => {
    expect(reopenPeriodSchema.safeParse({ reason: 'one\ntwo' }).success).toBe(false)
  })
})

describe('the close of a period and the chain status (LED-753)', () => {
  it('takes no body, sent empty or not sent', () => {
    expect(closePeriodSchema.safeParse({}).success).toBe(true)
    expect(closePeriodSchema.safeParse(undefined).success).toBe(true)
  })

  it('refuses an organizationId in the body of a close and in the query of the chain status', () => {
    expect(closePeriodSchema.safeParse({ organizationId: randomUUID() }).success).toBe(false)
    expect(chainStatusQuerySchema.safeParse({}).success).toBe(true)
    expect(chainStatusQuerySchema.safeParse({ organizationId: randomUUID() }).success).toBe(false)
  })
})

describe('the trial balance', () => {
  it('asks for a period and may name a store', () => {
    expect(trialBalanceQuerySchema.safeParse({ periodId: randomUUID() }).success).toBe(true)
    expect(
      trialBalanceQuerySchema.safeParse({ periodId: randomUUID(), storeId: randomUUID() }).success
    ).toBe(true)
    expect(trialBalanceQuerySchema.safeParse({}).success).toBe(false)
    expect(trialBalanceQuerySchema.safeParse({ periodId: 'nope' }).success).toBe(false)
  })
})

describe('the ledger', () => {
  const accountId = randomUUID()

  it('reads a page of at most the limit', () => {
    expect(ledgerQuerySchema.safeParse({ accountId, limit: '50' }).success).toBe(true)
    expect(ledgerQuerySchema.safeParse({ accountId, limit: '201' }).success).toBe(false)
    expect(ledgerQuerySchema.safeParse({ accountId, limit: '0' }).success).toBe(false)
  })

  it('refuses a day that does not exist and a range that goes backwards', () => {
    expect(ledgerQuerySchema.safeParse({ accountId, from: '2026-02-31' }).success).toBe(false)
    expect(
      ledgerQuerySchema.safeParse({ accountId, from: '2026-02-02', to: '2026-02-01' }).success
    ).toBe(false)
  })

  it('takes a cursor of the shape it writes, and nothing else', () => {
    expect(ledgerQuerySchema.safeParse({ accountId, cursor: '2026-01-15:12:2' }).success).toBe(true)
    expect(ledgerQuerySchema.safeParse({ accountId, cursor: "1'; DROP TABLE x" }).success).toBe(
      false
    )
    expect(ledgerQuerySchema.safeParse({ accountId, cursor: '2026-01-15:12' }).success).toBe(false)
  })
})

describe('the CSV files', () => {
  it('cover at most a year, from the first day to the last', () => {
    expect(journalCsvQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-31' }).success).toBe(
      true
    )
    expect(journalCsvQuerySchema.safeParse({ from: '2025-01-01', to: '2026-12-31' }).success).toBe(
      false
    )
    expect(journalCsvQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false)
  })

  it('ask the ledger for one account and a range', () => {
    const accountId = randomUUID()
    expect(
      ledgerCsvQuerySchema.safeParse({ accountId, from: '2026-01-01', to: '2026-01-31' }).success
    ).toBe(true)
    expect(ledgerCsvQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success).toBe(
      false
    )
  })
})

describe('the party filter of the ledger', () => {
  const accountId = randomUUID()

  it('takes a type alone, or a type with an id, and refuses an id without its type', () => {
    expect(ledgerQuerySchema.safeParse({ accountId, partyType: 'supplier' }).success).toBe(true)
    expect(
      ledgerQuerySchema.safeParse({ accountId, partyType: 'supplier', partyId: randomUUID() })
        .success
    ).toBe(true)
    expect(ledgerQuerySchema.safeParse({ accountId, partyId: randomUUID() }).success).toBe(false)
    expect(ledgerQuerySchema.safeParse({ accountId, partyType: 'planet' }).success).toBe(false)
  })

  it('is the same for the CSV of the ledger', () => {
    const query = { accountId, from: '2026-01-01', to: '2026-01-31' }
    expect(ledgerCsvQuerySchema.safeParse({ ...query, partyType: 'customer' }).success).toBe(true)
    expect(ledgerCsvQuerySchema.safeParse({ ...query, partyId: randomUUID() }).success).toBe(false)
  })
})

describe('the balances of the accounts at a date', () => {
  it('asks for a calendar day and may name a store', () => {
    expect(accountBalancesQuerySchema.safeParse({ asOf: '2026-01-31' }).success).toBe(true)
    expect(
      accountBalancesQuerySchema.safeParse({ asOf: '2026-01-31', storeId: randomUUID() }).success
    ).toBe(true)
    expect(accountBalancesQuerySchema.safeParse({}).success).toBe(false)
    expect(accountBalancesQuerySchema.safeParse({ asOf: '2026-02-31' }).success).toBe(false)
    expect(accountBalancesQuerySchema.safeParse({ asOf: '2026-01-31', extra: 1 }).success).toBe(
      false
    )
  })
})

describe('the journal of a range', () => {
  const range = { from: '2026-01-01', to: '2026-01-31' }

  it('reads a page of at most 100 entries, after an entry number', () => {
    expect(journalQuerySchema.safeParse({ ...range, limit: '100', cursor: '12' }).success).toBe(
      true
    )
    expect(journalQuerySchema.safeParse({ ...range, limit: '101' }).success).toBe(false)
    expect(journalQuerySchema.safeParse({ ...range, cursor: "1'; DROP" }).success).toBe(false)
    expect(journalQuerySchema.safeParse({ ...range, cursor: '9223372036854775808' }).success).toBe(
      false
    )
  })

  it('refuses a range that goes backwards or is longer than a fiscal year', () => {
    expect(journalQuerySchema.safeParse({ from: '2026-02-02', to: '2026-02-01' }).success).toBe(
      false
    )
    expect(journalQuerySchema.safeParse({ from: '2025-01-01', to: '2026-12-31' }).success).toBe(
      false
    )
    expect(journalQuerySchema.safeParse({ from: '2026-01-01' }).success).toBe(false)
  })
})
