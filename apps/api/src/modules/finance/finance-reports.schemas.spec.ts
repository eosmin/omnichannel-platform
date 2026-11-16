import { randomUUID } from 'node:crypto'

import {
  journalCsvQuerySchema,
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
