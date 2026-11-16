import type { FinanceAccountView } from '@platform/api-client'

import {
  accountDraftOf,
  accountProblem,
  accountRowsOf,
  canBeCash,
  cashAccountsOf,
  createAccountInputOf,
  emptyAccountDraft,
  parentOptionsOf,
  postableAccountsOf,
  accountLabelsOf,
  updateAccountInputOf
} from './account-form'

const account = (over: Partial<FinanceAccountView>): FinanceAccountView => ({
  id: 'a1',
  code: '1000',
  name: 'Cash',
  type: 'asset',
  normalSide: 'debit',
  parentId: null,
  isPostable: true,
  cashKind: null,
  isSystem: false,
  active: true,
  currency: 'USD',
  createdAt: '2026-11-15T10:00:00.000Z',
  ...over
})

describe('accountProblem', () => {
  const valid = { ...emptyAccountDraft(), code: '1100', name: 'Bank' }

  it('accepts a code and a name', () => {
    expect(accountProblem(valid)).toBeNull()
  })

  it.each(['', ' ', 'a b', '-1', 'x'.repeat(21), 'ñ1'])('refuses the code %j', code => {
    expect(accountProblem({ ...valid, code })).toBe('code')
  })

  it('refuses an empty name and one that is too long', () => {
    expect(accountProblem({ ...valid, name: '   ' })).toBe('name')
    expect(accountProblem({ ...valid, name: 'n'.repeat(151) })).toBe('name')
  })

  it('refuses a kind of cash on an account that is not an asset', () => {
    expect(accountProblem({ ...valid, type: 'expense', cashKind: 'bank' })).toBe('cashKind')
    expect(accountProblem({ ...valid, type: 'asset', cashKind: 'bank' })).toBeNull()
    expect(canBeCash('asset')).toBe(true)
    expect(canBeCash('liability')).toBe(false)
  })
})

describe('the input of an account', () => {
  it('trims, and sends no parent and no kind of cash as null', () => {
    expect(
      createAccountInputOf({ ...emptyAccountDraft(), code: ' 1100 ', name: ' Bank ' })
    ).toEqual({
      code: '1100',
      name: 'Bank',
      type: 'asset',
      parentId: null,
      isPostable: true,
      cashKind: null
    })
  })

  it('sends only what changed', () => {
    const current = account({ parentId: 'p1', cashKind: 'bank' })
    const draft = { ...accountDraftOf(current), name: 'Main bank' }

    expect(updateAccountInputOf(current, draft)).toEqual({ name: 'Main bank' })
    expect(updateAccountInputOf(current, accountDraftOf(current))).toEqual({})
  })

  it('sends null to take the parent and the kind of cash away', () => {
    const current = account({ parentId: 'p1', cashKind: 'bank' })

    expect(
      updateAccountInputOf(current, { ...accountDraftOf(current), parentId: '', cashKind: '' })
    ).toEqual({ parentId: null, cashKind: null })
  })
})

describe('accountRowsOf', () => {
  it('puts each account under its header, in the order of the codes', () => {
    const rows = accountRowsOf([
      account({ id: 'c', code: '1110', parentId: 'a' }),
      account({ id: 'b', code: '2000', isPostable: false }),
      account({ id: 'a', code: '1000', isPostable: false }),
      account({ id: 'd', code: '1090', parentId: 'a' }),
      account({ id: 'e', code: '2100', parentId: 'b' })
    ])

    expect(rows.map(row => [row.account.id, row.depth])).toEqual([
      ['a', 0],
      ['d', 1],
      ['c', 1],
      ['b', 0],
      ['e', 1]
    ])
  })

  it('orders codes as numbers where they are numbers', () => {
    const rows = accountRowsOf([account({ id: 'x', code: '10' }), account({ id: 'y', code: '9' })])

    expect(rows.map(row => row.account.id)).toEqual(['y', 'x'])
  })

  it('draws an account whose parent is not in the list at the top, never loses it', () => {
    const rows = accountRowsOf([account({ id: 'lost', code: '5000', parentId: 'gone' })])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.depth).toBe(0)
  })

  it('draws every account of a loop of parents once, none is lost', () => {
    const rows = accountRowsOf([
      account({ id: 'a', code: '1', parentId: 'b' }),
      account({ id: 'b', code: '2', parentId: 'a' }),
      account({ id: 'self', code: '3', parentId: 'self' }),
      account({ id: 'under', code: '4', parentId: 'a' })
    ])

    expect(rows.map(row => row.account.id).sort()).toEqual(['a', 'b', 'self', 'under'])
  })
})

describe('the choices of accounts', () => {
  const list = [
    account({ id: 'h', code: '1', isPostable: false }),
    account({ id: 'p', code: '2' }),
    account({ id: 'off', code: '3', active: false })
  ]

  it('offers as a parent only the headers, never the account itself', () => {
    expect(parentOptionsOf(list, null).map(item => item.id)).toEqual(['h'])
    expect(parentOptionsOf(list, 'h')).toEqual([])
  })

  it('does not offer a header under one of its own children as the parent', () => {
    const tree = [
      account({ id: 'top', code: '1', isPostable: false }),
      account({ id: 'mid', code: '2', isPostable: false, parentId: 'top' }),
      account({ id: 'low', code: '3', isPostable: false, parentId: 'mid' }),
      account({ id: 'other', code: '4', isPostable: false })
    ]

    expect(parentOptionsOf(tree, 'top').map(item => item.id)).toEqual(['other'])
    expect(parentOptionsOf(tree, 'mid').map(item => item.id)).toEqual(['top', 'other'])
  })

  it('offers for money the accounts of a kind of cash, and keeps the one already chosen', () => {
    const money = [
      account({ id: 'cash', code: '1', cashKind: 'cash' }),
      account({ id: 'bank', code: '2', cashKind: 'bank' }),
      account({ id: 'sales', code: '3', type: 'income' }),
      account({ id: 'old', code: '4' })
    ]

    expect(cashAccountsOf(money, []).map(item => item.id)).toEqual(['cash', 'bank'])
    expect(cashAccountsOf(money, [], ['bank']).map(item => item.id)).toEqual(['bank'])
    expect(cashAccountsOf(money, ['old'], ['bank']).map(item => item.id)).toEqual(['bank', 'old'])
  })

  it('offers the accounts that post and are on, and keeps the one already chosen even if it was turned off', () => {
    expect(postableAccountsOf(list, []).map(item => item.id)).toEqual(['p'])
    expect(postableAccountsOf(list, ['off']).map(item => item.id)).toEqual(['p', 'off'])
  })
})

describe('accountLabelsOf', () => {
  const label = accountLabelsOf([account({ id: 'a1', code: '1101', name: 'Cash' })])

  it('names an account by its code and its name', () => {
    expect(label('a1')).toBe('1101 · Cash')
  })

  it('shows an id that is not in the chart as itself, and nothing for no account', () => {
    expect(label('zz')).toBe('zz')
    expect(label(null)).toBe('')
  })
})
