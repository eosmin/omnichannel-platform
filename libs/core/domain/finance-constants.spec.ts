import {
  AccountRole,
  AccountType,
  CashKindAccountTypes,
  FinanceCountryCodes,
  FinanceLimits,
  FiscalDocumentStatus,
  FiscalDocumentStatusTransitions,
  JournalEntryType,
  NormalSide,
  NormalSideOfType,
  PeriodStatus,
  PeriodStatusTransitions,
  PurchaseOrderStatus,
  PurchaseOrderStatusTransitions,
  RolesFreeOfHistory,
  RolesPinnedByHistory
} from './finance-constants'

describe('the finance enums', () => {
  it('say what side each account type grows on, none left out', () => {
    expect(Object.keys(NormalSideOfType).sort()).toEqual(Object.values(AccountType).sort())
    const debit = Object.entries(NormalSideOfType)
      .filter(([, side]) => side === NormalSide.DEBIT)
      .map(([type]) => type)
    expect(debit.sort()).toEqual(['asset', 'cost_of_sales', 'expense'])
  })

  it('name every role once, in lower snake case', () => {
    const roles: string[] = Object.values(AccountRole)
    expect(new Set(roles).size).toBe(roles.length)
    expect(roles).toHaveLength(23)
    for (const [key, value] of Object.entries(AccountRole)) {
      expect(key).toBe(value.toUpperCase())
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/)
    }
  })

  it('classify every role as pinned by history or free of it, once (HC-119)', () => {
    const pinned: string[] = [...RolesPinnedByHistory]
    const free: string[] = [...RolesFreeOfHistory]
    expect(pinned.filter(role => free.includes(role))).toEqual([])
    expect([...pinned, ...free].sort()).toEqual(Object.values(AccountRole).sort())
  })

  it('name every entry type once', () => {
    const types: string[] = Object.values(JournalEntryType)
    expect(new Set(types).size).toBe(types.length)
    expect(types).toContain('reversal')
  })

  it('keeps cash kinds to assets', () => {
    expect(CashKindAccountTypes).toEqual([AccountType.ASSET])
  })
})

describe('the transition tables', () => {
  it('cover every status, and only name statuses that exist', () => {
    const check = (
      statuses: Record<string, string>,
      table: Record<string, readonly string[]>
    ): void => {
      const all = Object.values(statuses)
      expect(Object.keys(table).sort()).toEqual([...all].sort())
      for (const status of Object.values(table).flat()) expect(all).toContain(status)
    }
    check(PeriodStatus, PeriodStatusTransitions)
    check(PurchaseOrderStatus, PurchaseOrderStatusTransitions)
    check(FiscalDocumentStatus, FiscalDocumentStatusTransitions)
  })

  it('lets a period close and, through the reopen action only, open again', () => {
    expect(PeriodStatusTransitions[PeriodStatus.OPEN]).toEqual([PeriodStatus.CLOSED])
    expect(PeriodStatusTransitions[PeriodStatus.CLOSED]).toEqual([PeriodStatus.OPEN])
  })

  it('ends a purchase order in closed or cancelled, and a fiscal document in voided', () => {
    expect(PurchaseOrderStatusTransitions[PurchaseOrderStatus.CLOSED]).toEqual([])
    expect(PurchaseOrderStatusTransitions[PurchaseOrderStatus.CANCELLED]).toEqual([])
    expect(FiscalDocumentStatusTransitions[FiscalDocumentStatus.VOIDED]).toEqual([])
    // A purchase with a receipt cannot be cancelled, only closed
    expect(PurchaseOrderStatusTransitions[PurchaseOrderStatus.PARTIALLY_RECEIVED]).not.toContain(
      PurchaseOrderStatus.CANCELLED
    )
    expect(FiscalDocumentStatusTransitions[FiscalDocumentStatus.REJECTED]).toEqual([
      FiscalDocumentStatus.QUEUED
    ])
  })
})

describe('the limits', () => {
  it('keep the code pattern the database holds', () => {
    expect(FinanceLimits.ACCOUNT_CODE_PATTERN.test('1101')).toBe(true)
    expect(FinanceLimits.ACCOUNT_CODE_PATTERN.test('11 01')).toBe(false)
    expect(FinanceLimits.MAX_LINE_CENTS).toBe(2 ** 31 - 1)
    expect(FinanceCountryCodes.EL_SALVADOR).toBe('SV')
  })
})
