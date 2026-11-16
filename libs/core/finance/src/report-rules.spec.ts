import { normalBalance, periodEnded, trialBalanceTotals, withRunningBalance } from './report-rules'

describe('trialBalanceTotals', () => {
  it('sums the debits and the credits and says whether they match', () => {
    expect(
      trialBalanceTotals([
        { debitCents: 1000n, creditCents: 0n },
        { debitCents: 0n, creditCents: 1000n }
      ])
    ).toEqual({ debitCents: 1000n, creditCents: 1000n, balanced: true })
  })

  it('reports a difference of one cent as not balanced', () => {
    expect(
      trialBalanceTotals([
        { debitCents: 1001n, creditCents: 0n },
        { debitCents: 0n, creditCents: 1000n }
      ]).balanced
    ).toBe(false)
  })

  it('does not lose a cent over amounts beyond 2^53', () => {
    const big = 9_007_199_254_740_993n
    expect(trialBalanceTotals([{ debitCents: big, creditCents: big }]).balanced).toBe(true)
    expect(trialBalanceTotals([{ debitCents: big, creditCents: big - 1n }]).balanced).toBe(false)
  })

  it('is balanced and zero for no rows', () => {
    expect(trialBalanceTotals([])).toEqual({ debitCents: 0n, creditCents: 0n, balanced: true })
  })
})

describe('normalBalance', () => {
  it('grows on the normal side of the account', () => {
    expect(normalBalance({ debitCents: 500n, creditCents: 200n }, true)).toBe(300n)
    expect(normalBalance({ debitCents: 200n, creditCents: 500n }, false)).toBe(300n)
    expect(normalBalance({ debitCents: 500n, creditCents: 200n }, false)).toBe(-300n)
  })
})

describe('withRunningBalance', () => {
  it('carries the opening balance through every line', () => {
    const lines = withRunningBalance(
      100n,
      [
        { key: 'a', debitCents: 50n, creditCents: 0n },
        { key: 'b', debitCents: 0n, creditCents: 120n }
      ],
      true
    )
    expect(lines.map(line => line.runningCents)).toEqual([150n, 30n])
  })

  it('ends where the totals say it ends', () => {
    const input = [
      { key: 'a', debitCents: 0n, creditCents: 70n },
      { key: 'b', debitCents: 20n, creditCents: 0n }
    ]
    const lines = withRunningBalance(0n, input, false)
    expect(lines.at(-1)?.runningCents).toBe(normalBalance(trialBalanceTotals(input), false))
  })
})

describe('periodEnded', () => {
  it('is false on the last day and true the day after', () => {
    expect(periodEnded('2026-11-30', '2026-11-30')).toBe(false)
    expect(periodEnded('2026-11-30', '2026-12-01')).toBe(true)
  })
})
