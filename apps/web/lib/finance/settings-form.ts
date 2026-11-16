import type { FinanceSettingsView, UpdateFinanceSettingsInput } from '@platform/api-client'

// The settings of the books (TDD_18 §6.4, §7): when a sale counts, how a fraction of a cent of tax is placed, whether the shipping fee
// carries the tax and where a cent that cannot be placed goes. The rounding account can be changed but never taken away.
export interface SettingsDraft {
  recognizeSaleOn: string
  taxRounding: string
  shippingTaxed: boolean
  roundingAccountId: string
}

export const settingsDraftOf = (settings: FinanceSettingsView): SettingsDraft => ({
  recognizeSaleOn: settings.recognizeSaleOn,
  taxRounding: settings.taxRounding,
  shippingTaxed: settings.shippingTaxed,
  roundingAccountId: settings.roundingAccountId ?? ''
})

// Only the keys that differ, so a save of one choice never rewrites the others
export function settingsChangesOf(
  settings: FinanceSettingsView,
  draft: SettingsDraft
): UpdateFinanceSettingsInput {
  const changes: UpdateFinanceSettingsInput = {}
  if (draft.recognizeSaleOn !== settings.recognizeSaleOn) {
    changes.recognizeSaleOn = draft.recognizeSaleOn
  }
  if (draft.taxRounding !== settings.taxRounding) changes.taxRounding = draft.taxRounding
  if (draft.shippingTaxed !== settings.shippingTaxed) changes.shippingTaxed = draft.shippingTaxed
  // Taking the account away is not a change the api takes: an empty choice sends nothing
  if (draft.roundingAccountId !== '' && draft.roundingAccountId !== settings.roundingAccountId) {
    changes.roundingAccountId = draft.roundingAccountId
  }
  return changes
}
