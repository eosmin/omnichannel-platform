import type {
  CreateFinanceTaxRateInput,
  FinanceAccountView,
  FinanceTaxRateView,
  UpdateFinanceTaxRateInput
} from '@platform/api-client'
import { AccountType, FinanceTaxLimits } from '@platform/core/domain'

import { postableAccountsOf } from './account-form'
import { bpsOfPercentText, percentOfBps } from './money'

// The form of a tax rate (TDD_18 §7). The rate is typed as a percent and sent as basis points, by whole numbers only.
export interface TaxRateDraft {
  code: string
  name: string
  percent: string
  outputAccountId: string
  inputAccountId: string
  isDefault: boolean
}

export const TaxRateFields = {
  CODE: 'code',
  NAME: 'name',
  PERCENT: 'percent',
  OUTPUT_ACCOUNT: 'outputAccount',
  INPUT_ACCOUNT: 'inputAccount'
} as const
export type TaxRateField = (typeof TaxRateFields)[keyof typeof TaxRateFields]

export const emptyTaxRateDraft = (): TaxRateDraft => ({
  code: '',
  name: '',
  percent: '',
  outputAccountId: '',
  inputAccountId: '',
  isDefault: false
})

export const taxRateDraftOf = (rate: FinanceTaxRateView): TaxRateDraft => ({
  code: rate.code,
  name: rate.name,
  percent: percentOfBps(rate.rateBps),
  outputAccountId: rate.outputAccountId,
  inputAccountId: rate.inputAccountId,
  isDefault: rate.isDefault
})

export function taxRateProblem(draft: TaxRateDraft): TaxRateField | null {
  if (!FinanceTaxLimits.CODE_PATTERN.test(draft.code.trim())) return TaxRateFields.CODE
  const name = draft.name.trim()
  if (name === '' || name.length > FinanceTaxLimits.NAME_MAX_LENGTH) return TaxRateFields.NAME
  const bps = bpsOfPercentText(draft.percent)
  if (bps === null || bps < FinanceTaxLimits.MIN_RATE_BPS || bps > FinanceTaxLimits.MAX_RATE_BPS) {
    return TaxRateFields.PERCENT
  }
  if (draft.outputAccountId === '') return TaxRateFields.OUTPUT_ACCOUNT
  if (draft.inputAccountId === '') return TaxRateFields.INPUT_ACCOUNT
  return null
}

// Call only after `taxRateProblem` said null: the percent is then a rate. A draft that is not one is a mistake of the caller and
// stops here: it is never turned into a rate of 0, which would zero a live tax
const bpsOf = (draft: TaxRateDraft): number => {
  const bps = bpsOfPercentText(draft.percent)
  if (bps === null) throw new Error('the percent of a tax rate was not checked')
  return bps
}

export function createTaxRateInputOf(draft: TaxRateDraft): CreateFinanceTaxRateInput {
  return {
    code: draft.code.trim(),
    name: draft.name.trim(),
    rateBps: bpsOf(draft),
    outputAccountId: draft.outputAccountId,
    inputAccountId: draft.inputAccountId,
    isDefault: draft.isDefault
  }
}

// Only the keys that differ. A rate becomes the default (true) and never stops being one by itself: another one takes its place.
export function updateTaxRateInputOf(
  rate: FinanceTaxRateView,
  draft: TaxRateDraft
): UpdateFinanceTaxRateInput {
  const changes: UpdateFinanceTaxRateInput = {}
  if (draft.code.trim() !== rate.code) changes.code = draft.code.trim()
  if (draft.name.trim() !== rate.name) changes.name = draft.name.trim()
  if (bpsOf(draft) !== rate.rateBps) changes.rateBps = bpsOf(draft)
  if (draft.outputAccountId !== rate.outputAccountId)
    changes.outputAccountId = draft.outputAccountId
  if (draft.inputAccountId !== rate.inputAccountId) changes.inputAccountId = draft.inputAccountId
  if (draft.isDefault && !rate.isDefault) changes.isDefault = true
  return changes
}

// The tax owed on sales is a liability and the tax to credit on purchases is an asset (the server refuses any other pair), so each
// select offers only its own type; the account already chosen stays, as in `postableAccountsOf`.
export const TaxAccountSides = { OUTPUT: 'output', INPUT: 'input' } as const
export type TaxAccountSide = (typeof TaxAccountSides)[keyof typeof TaxAccountSides]

export function taxAccountsOf(
  accounts: readonly FinanceAccountView[],
  side: TaxAccountSide,
  keep: readonly string[]
): FinanceAccountView[] {
  const type = side === TaxAccountSides.OUTPUT ? AccountType.LIABILITY : AccountType.ASSET
  return postableAccountsOf(accounts, keep).filter(
    account => account.type === String(type) || keep.includes(account.id)
  )
}
