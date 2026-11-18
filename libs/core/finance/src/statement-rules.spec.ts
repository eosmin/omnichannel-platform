import { AccountType, AgingBucketDays, StatementWarning } from '@platform/core/domain'

import {
  agingOf,
  balanceSheet,
  cashFlow,
  incomeStatement,
  type StatementAccount,
  statementSection
} from './statement-rules'

let next = 0
function account(
  type: AccountType,
  code: string,
  debitCents: bigint,
  creditCents: bigint,
  parentId: string | null = null
): StatementAccount {
  next += 1
  return {
    id: `a${String(next)}`,
    code,
    name: `account ${code}`,
    type,
    parentId,
    isPostable: true,
    debitCents,
    creditCents
  }
}

describe('statementSection', () => {
  it('reads each account on its normal side and totals them once', () => {
    const header = { ...account(AccountType.EXPENSE, '5', 0n, 0n), isPostable: false }
    const rent = account(AccountType.EXPENSE, '51', 1_000n, 0n, header.id)
    const refund = account(AccountType.EXPENSE, '52', 100n, 400n, header.id)
    const section = statementSection([rent, header, refund], AccountType.EXPENSE)
    expect(section.totalCents).toBe(700n)
    expect(section.rows.map(row => row.code)).toEqual(['5', '51', '52'])
    expect(section.rows[0]?.rollupCents).toBe(700n)
    expect(section.rows[2]?.balanceCents).toBe(-300n)
  })

  it('does not spin on a parent loop', () => {
    const a = account(AccountType.ASSET, '1', 10n, 0n)
    const b = account(AccountType.ASSET, '2', 5n, 0n, a.id)
    const looped = { ...a, parentId: b.id }
    expect(statementSection([looped, b], AccountType.ASSET).totalCents).toBe(15n)
  })
})

describe('incomeStatement', () => {
  it('computes the gross margin and the net result in whole cents', () => {
    const result = incomeStatement([
      account(AccountType.INCOME, '41', 0n, 10_000n),
      account(AccountType.COST_OF_SALES, '51', 6_001n, 0n),
      account(AccountType.EXPENSE, '61', 1_500n, 0n)
    ])
    expect(result.grossMarginCents).toBe(3_999n)
    expect(result.netResultCents).toBe(2_499n)
    expect(result.warnings).toEqual([])
  })

  it('warns instead of inventing a section that has no activity', () => {
    const result = incomeStatement([account(AccountType.INCOME, '41', 0n, 500n)])
    expect(result.warnings).toEqual([StatementWarning.NO_COST_OF_SALES])
    expect(incomeStatement([]).warnings).toEqual([
      StatementWarning.NO_INCOME,
      StatementWarning.NO_COST_OF_SALES
    ])
  })
})

describe('balanceSheet', () => {
  it('balances with the result of the period inside equity', () => {
    const sheet = balanceSheet([
      account(AccountType.ASSET, '11', 12_000n, 2_000n),
      account(AccountType.LIABILITY, '21', 0n, 3_000n),
      account(AccountType.EQUITY, '31', 0n, 5_000n),
      account(AccountType.INCOME, '41', 0n, 4_000n),
      account(AccountType.EXPENSE, '61', 2_000n, 0n)
    ])
    expect(sheet.assets.totalCents).toBe(10_000n)
    expect(sheet.resultCents).toBe(2_000n)
    expect(sheet.equityWithResultCents).toBe(7_000n)
    expect(sheet.balanced).toBe(true)
    expect(sheet.warnings).toEqual([])
  })

  it('names the incident when the identity fails', () => {
    const sheet = balanceSheet([account(AccountType.ASSET, '11', 100n, 0n)])
    expect(sheet.balanced).toBe(false)
    expect(sheet.warnings).toEqual([StatementWarning.NOT_BALANCED])
  })
})

describe('cashFlow', () => {
  it('nets each source and checks that the opening plus the movement is the closing', () => {
    const flow = cashFlow(
      [
        { source: 'remittance', inflowCents: 500n, outflowCents: 0n },
        { source: 'finance_transaction', inflowCents: 100n, outflowCents: 350n }
      ],
      1_000n,
      1_250n,
      true
    )
    expect(flow.netCents).toBe(250n)
    expect(flow.closes).toBe(true)
    expect(flow.sources.map(row => row.source)).toEqual(['finance_transaction', 'remittance'])
  })

  it('warns when the books do not close or no account is cash', () => {
    const flow = cashFlow([], 0n, 5n, false)
    expect(flow.warnings).toEqual([
      StatementWarning.NO_CASH_ACCOUNTS,
      StatementWarning.CASH_FLOW_DOES_NOT_CLOSE
    ])
  })
})

describe('agingOf', () => {
  const credit = (entryDate: string, cents: bigint) => ({
    entryDate,
    debitCents: 0n,
    creditCents: cents
  })
  const debit = (entryDate: string, cents: bigint) => ({
    entryDate,
    debitCents: cents,
    creditCents: 0n
  })

  it('settles a reversal against the entry it reverses, not against the oldest open item (HC-108)', () => {
    const aging = agingOf(
      [
        { ...credit('2026-09-01', 1_000n), entryId: 'old' },
        { ...credit('2026-11-10', 500n), entryId: 'recent' },
        { ...debit('2026-11-12', 500n), entryId: 'reversal', reversesEntryId: 'recent' }
      ],
      '2026-11-15',
      true,
      AgingBucketDays
    )
    // The recent invoice is cancelled: what is open is the old 1000, 75 days old, and nothing of the recent one
    expect(aging.bucketsCents).toEqual([0n, 0n, 1_000n, 0n])
    expect(aging.totalCents).toBe(1_000n)
    expect(aging.unappliedCents).toBe(0n)
  })

  it('settles what the reversed entry no longer has open oldest first, and a payment as before', () => {
    const aging = agingOf(
      [
        { ...credit('2026-09-01', 1_000n), entryId: 'old' },
        { ...credit('2026-11-10', 500n), entryId: 'recent' },
        { ...debit('2026-11-11', 200n), entryId: 'payment' },
        { ...debit('2026-11-12', 500n), entryId: 'reversal', reversesEntryId: 'recent' }
      ],
      '2026-11-15',
      true,
      AgingBucketDays
    )
    // The payment took 200 of the old one; the reversal cancels the 500 of the recent one
    expect(aging.bucketsCents).toEqual([0n, 0n, 800n, 0n])
    expect(aging.totalCents).toBe(800n)
  })

  it('settles the oldest open item first and ages what is left', () => {
    const aging = agingOf(
      [credit('2026-06-01', 1_000n), credit('2026-09-20', 500n), debit('2026-10-01', 1_200n)],
      '2026-11-15',
      true,
      AgingBucketDays
    )
    // 1000 from June is settled and 200 of the 500 of September: 300 is left, 56 days old
    expect(aging.bucketsCents).toEqual([0n, 300n, 0n, 0n])
    expect(aging.totalCents).toBe(300n)
    expect(aging.unappliedCents).toBe(0n)
  })

  it('puts an item in the bucket its age falls in and the last one has no end', () => {
    const aging = agingOf(
      [credit('2026-11-10', 10n), credit('2026-10-01', 20n), credit('2026-08-01', 30n)],
      '2026-11-15',
      true,
      AgingBucketDays
    )
    expect(aging.bucketsCents).toEqual([10n, 20n, 0n, 30n])
  })

  it('keeps a payment larger than what was open apart', () => {
    const aging = agingOf(
      [credit('2026-11-01', 100n), debit('2026-11-02', 150n)],
      '2026-11-15',
      true,
      AgingBucketDays
    )
    expect(aging.bucketsCents).toEqual([0n, 0n, 0n, 0n])
    expect(aging.unappliedCents).toBe(50n)
    expect(aging.totalCents).toBe(-50n)
  })

  it('lets a payment dated before its invoice pay it', () => {
    const aging = agingOf(
      [debit('2026-11-01', 100n), credit('2026-11-05', 300n)],
      '2026-11-15',
      true,
      AgingBucketDays
    )
    expect(aging.bucketsCents).toEqual([200n, 0n, 0n, 0n])
    expect(aging.unappliedCents).toBe(0n)
    expect(aging.totalCents).toBe(200n)
  })

  it('ages a receivable by its debits', () => {
    const aging = agingOf([debit('2026-11-14', 80n)], '2026-11-15', false, AgingBucketDays)
    expect(aging.bucketsCents).toEqual([80n, 0n, 0n, 0n])
  })
})
