import { AccountRole, AccountType, CashKind, PaymentMethod } from '@platform/core/domain'

import { accountProblems, type ChartNode, parentProblem } from '../account-rules'

import { financeTemplateCountries, financeTemplateFor, SvTemplate } from './index'

describe('the template of El Salvador', () => {
  const byCode = new Map(SvTemplate.accounts.map(account => [account.code, account]))

  it('is the one chosen by its country, and is the only one that ships', () => {
    expect(financeTemplateFor('SV')).toBe(SvTemplate)
    expect(financeTemplateFor('CO')).toBeNull()
    // An inherited key of a plain object is not a country
    expect(financeTemplateFor('constructor')).toBeNull()
    expect(financeTemplateFor('toString')).toBeNull()
    expect(financeTemplateCountries()).toEqual(['SV'])
  })

  it('has unique codes and valid accounts', () => {
    expect(byCode.size).toBe(SvTemplate.accounts.length)
    for (const account of SvTemplate.accounts) {
      expect([account.code, accountProblems(account)]).toEqual([account.code, []])
    }
  })

  it('lists every parent before its children, as a header of the same type that fits the chart', () => {
    const seen: ChartNode[] = []
    for (const account of SvTemplate.accounts) {
      const nodes = seen
      const parent = account.parentCode === null ? null : byCode.get(account.parentCode)
      if (account.parentCode !== null) expect(parent).toBeDefined()
      expect(parentProblem(nodes, account.code, account.type, account.parentCode)).toBeNull()
      seen.push({
        id: account.code,
        parentId: account.parentCode,
        type: account.type,
        isPostable: account.isPostable
      })
    }
  })

  it('numbers each root by its type, as the TDD says', () => {
    const roots = Object.fromEntries(
      SvTemplate.accounts.filter(a => a.parentCode === null).map(a => [a.code, a.type])
    )
    expect(roots).toEqual({
      '1': AccountType.ASSET,
      '2': AccountType.LIABILITY,
      '3': AccountType.EQUITY,
      '4': AccountType.INCOME,
      '5': AccountType.COST_OF_SALES,
      '6': AccountType.EXPENSE
    })
    for (const account of SvTemplate.accounts) {
      const root = account.code.slice(0, 1)
      expect(SvTemplate.accounts.find(a => a.code === root)?.type).toBe(account.type)
    }
  })

  it('maps every role to a postable account, of a type that suits it', () => {
    expect(Object.keys(SvTemplate.roles).sort()).toEqual(Object.values(AccountRole).sort())
    for (const [role, code] of Object.entries(SvTemplate.roles)) {
      const account = byCode.get(code)
      expect([role, account?.isPostable]).toEqual([role, true])
    }
    const typeOf = (role: AccountRole): AccountType | undefined =>
      byCode.get(SvTemplate.roles[role])?.type
    expect(typeOf(AccountRole.INVENTORY)).toBe(AccountType.ASSET)
    expect(typeOf(AccountRole.RECEIVABLE_CARRIERS)).toBe(AccountType.ASSET)
    expect(typeOf(AccountRole.VAT_INPUT)).toBe(AccountType.ASSET)
    expect(typeOf(AccountRole.VAT_OUTPUT)).toBe(AccountType.LIABILITY)
    expect(typeOf(AccountRole.PAYABLE_SUPPLIERS)).toBe(AccountType.LIABILITY)
    expect(typeOf(AccountRole.CUSTOMER_ADVANCES)).toBe(AccountType.LIABILITY)
    expect(typeOf(AccountRole.SALES_REVENUE)).toBe(AccountType.INCOME)
    expect(typeOf(AccountRole.INVENTORY_GAIN)).toBe(AccountType.INCOME)
    expect(typeOf(AccountRole.COST_OF_GOODS_SOLD)).toBe(AccountType.COST_OF_SALES)
    expect(typeOf(AccountRole.OPENING_EQUITY)).toBe(AccountType.EQUITY)
    expect(typeOf(AccountRole.INVENTORY_LOSS)).toBe(AccountType.EXPENSE)
    expect(typeOf(AccountRole.ROUNDING)).toBe(AccountType.EXPENSE)
  })

  it('puts cash, bank and wallet on cash-kind accounts and nothing else', () => {
    expect(byCode.get(SvTemplate.roles[AccountRole.CASH_DEFAULT])?.cashKind).toBe(CashKind.CASH)
    expect(byCode.get(SvTemplate.roles[AccountRole.BANK_DEFAULT])?.cashKind).toBe(CashKind.BANK)
    expect(
      SvTemplate.accounts
        .filter(a => a.cashKind !== undefined)
        .map(a => a.cashKind)
        .sort()
    ).toEqual([CashKind.BANK, CashKind.CASH, CashKind.CASH, CashKind.WALLET].sort())
  })

  it('sends each payment method to a cash-kind account, and leaves cash on delivery to the carrier receivable', () => {
    expect(Object.keys(SvTemplate.paymentMethods).sort()).toEqual(
      [PaymentMethod.CASH, PaymentMethod.TRANSFER, PaymentMethod.CARD, PaymentMethod.OTHER].sort()
    )
    for (const code of Object.values(SvTemplate.paymentMethods)) {
      expect(byCode.get(code)?.cashKind).toBeDefined()
    }
    expect(SvTemplate.paymentMethods[PaymentMethod.CASH_ON_DELIVERY]).toBeUndefined()
  })

  it('seeds exactly one default tax rate, in basis points, whose roles map to a liability and an asset', () => {
    expect(SvTemplate.taxRates.filter(rate => rate.isDefault)).toHaveLength(1)
    expect(new Set(SvTemplate.taxRates.map(rate => rate.code)).size).toBe(
      SvTemplate.taxRates.length
    )
    for (const rate of SvTemplate.taxRates) {
      expect([
        rate.code,
        Number.isInteger(rate.rateBps) && rate.rateBps >= 0 && rate.rateBps <= 10_000
      ]).toEqual([rate.code, true])
    }
    const [vat] = SvTemplate.taxRates
    expect(vat?.rateBps).toBe(1300)
    expect(byCode.get(SvTemplate.roles[vat?.outputRole as AccountRole])?.type).toBe(
      AccountType.LIABILITY
    )
    expect(byCode.get(SvTemplate.roles[vat?.inputRole as AccountRole])?.type).toBe(
      AccountType.ASSET
    )
  })
})
