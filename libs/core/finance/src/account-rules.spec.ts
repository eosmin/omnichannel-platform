import { AccountType, CashKind, FinanceLimits, NormalSide } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  type AccountDraft,
  accountProblems,
  type ChartNode,
  lockedChange,
  normalSideOf,
  parentProblem
} from './account-rules'

const valid: AccountDraft = {
  code: '1101',
  name: 'Caja general',
  type: AccountType.ASSET,
  isPostable: true
}

describe('normalSideOf', () => {
  it('debits for assets, cost of sales and expenses; credits for the rest', () => {
    expect(normalSideOf(AccountType.ASSET)).toBe(NormalSide.DEBIT)
    expect(normalSideOf(AccountType.COST_OF_SALES)).toBe(NormalSide.DEBIT)
    expect(normalSideOf(AccountType.EXPENSE)).toBe(NormalSide.DEBIT)
    expect(normalSideOf(AccountType.LIABILITY)).toBe(NormalSide.CREDIT)
    expect(normalSideOf(AccountType.EQUITY)).toBe(NormalSide.CREDIT)
    expect(normalSideOf(AccountType.INCOME)).toBe(NormalSide.CREDIT)
  })
})

describe('accountProblems', () => {
  it('accepts a good account, with and without a cash kind', () => {
    expect(accountProblems(valid)).toEqual([])
    expect(accountProblems({ ...valid, cashKind: CashKind.CASH })).toEqual([])
  })
  it.each(['', ' 1101', '11 01', '11/01', '-1', 'x'.repeat(21), '１１０１'])(
    'refuses the code %j',
    code => {
      expect(accountProblems({ ...valid, code })).toContain('code')
    }
  )
  it.each(['', ' Caja', 'Caja ', 'Ca\nja', 'x'.repeat(FinanceLimits.ACCOUNT_NAME_MAX_LENGTH + 1)])(
    'refuses the name %j',
    name => {
      expect(accountProblems({ ...valid, name })).toContain('name')
    }
  )
  it('refuses a cash kind on anything but a postable asset', () => {
    expect(
      accountProblems({ ...valid, type: AccountType.EXPENSE, cashKind: CashKind.BANK })
    ).toContain('cash_kind_type')
    expect(accountProblems({ ...valid, isPostable: false, cashKind: CashKind.BANK })).toContain(
      'cash_kind_postable'
    )
  })
  it('refuses a type or a cash kind it does not know', () => {
    expect(accountProblems({ ...valid, type: 'nope' as AccountType })).toContain('unknown_type')
    expect(accountProblems({ ...valid, cashKind: 'nope' as CashKind })).toContain(
      'unknown_cash_kind'
    )
  })
})

const chart: ChartNode[] = [
  { id: 'root', parentId: null, type: AccountType.ASSET, isPostable: false },
  { id: 'group', parentId: 'root', type: AccountType.ASSET, isPostable: false },
  { id: 'leaf', parentId: 'group', type: AccountType.ASSET, isPostable: true },
  { id: 'liab', parentId: null, type: AccountType.LIABILITY, isPostable: false }
]

describe('parentProblem', () => {
  it('allows a root and a header of the same type', () => {
    expect(parentProblem(chart, 'leaf', AccountType.ASSET, null)).toBeNull()
    expect(parentProblem(chart, 'leaf', AccountType.ASSET, 'root')).toBeNull()
    expect(parentProblem(chart, null, AccountType.ASSET, 'group')).toBeNull()
  })
  it('refuses a parent that does not exist, takes entries, or is of another type', () => {
    expect(parentProblem(chart, 'leaf', AccountType.ASSET, 'missing')).toBe(
      ErrorCodes.RESOURCE_NOT_FOUND
    )
    expect(parentProblem(chart, 'group', AccountType.ASSET, 'leaf')).toBe('parent_postable')
    expect(parentProblem(chart, 'leaf', AccountType.ASSET, 'liab')).toBe('parent_type')
  })
  it('refuses a cycle: under itself or under a descendant', () => {
    expect(parentProblem(chart, 'root', AccountType.ASSET, 'root')).toBe('cycle')
    expect(parentProblem(chart, 'root', AccountType.ASSET, 'group')).toBe('cycle')
  })
  it('refuses a chart already looping, without looping itself', () => {
    const loop: ChartNode[] = [
      { id: 'a', parentId: 'b', type: AccountType.ASSET, isPostable: false },
      { id: 'b', parentId: 'a', type: AccountType.ASSET, isPostable: false }
    ]
    expect(parentProblem(loop, 'x', AccountType.ASSET, 'a')).toBe('cycle')
  })
  it('refuses a place that nests deeper than the limit, counting what hangs below the account', () => {
    const deep: ChartNode[] = Array.from(
      { length: FinanceLimits.MAX_ACCOUNT_DEPTH },
      (_, index) => ({
        id: `n${index}`,
        parentId: index === 0 ? null : `n${index - 1}`,
        type: AccountType.ASSET,
        isPostable: false
      })
    )
    const last = `n${FinanceLimits.MAX_ACCOUNT_DEPTH - 1}`
    expect(parentProblem(deep, null, AccountType.ASSET, last)).toBe('too_deep')
    expect(
      parentProblem(deep, null, AccountType.ASSET, `n${FinanceLimits.MAX_ACCOUNT_DEPTH - 2}`)
    ).toBeNull()
    // A group with a child moved under a parent one level from the limit: the child would pass it
    const withChild: ChartNode[] = [
      ...deep.slice(0, FinanceLimits.MAX_ACCOUNT_DEPTH - 1),
      { id: 'g', parentId: null, type: AccountType.ASSET, isPostable: false },
      { id: 'c', parentId: 'g', type: AccountType.ASSET, isPostable: true }
    ]
    expect(
      parentProblem(withChild, 'g', AccountType.ASSET, `n${FinanceLimits.MAX_ACCOUNT_DEPTH - 2}`)
    ).toBe('too_deep')
  })
})

describe('lockedChange', () => {
  const asset = { type: AccountType.ASSET, isPostable: true }
  it('changes nothing for an account without entries', () => {
    expect(lockedChange(false, asset, { type: AccountType.EXPENSE, isPostable: false })).toBeNull()
  })
  it('locks the type and the header status of an account with entries', () => {
    expect(lockedChange(true, asset, { type: AccountType.EXPENSE, isPostable: true })).toBe(
      ErrorCodes.FINANCE_ACCOUNT_TYPE_LOCKED
    )
    expect(lockedChange(true, asset, { type: AccountType.ASSET, isPostable: false })).toBe(
      ErrorCodes.FINANCE_ACCOUNT_HAS_ENTRIES
    )
    expect(lockedChange(true, asset, asset)).toBeNull()
  })
})
