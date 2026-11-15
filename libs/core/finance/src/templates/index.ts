import { FinanceCountryCodes } from '@platform/core/domain'

import { SvTemplate } from './sv'
import type { FinanceTemplate } from './types'

export * from './sv'
export * from './types'

// The templates that ship with the module, by country. Colombia is a second file later with no change to the ledger.
const TEMPLATES: Readonly<Record<string, FinanceTemplate>> = {
  [FinanceCountryCodes.EL_SALVADOR]: SvTemplate
}

export const financeTemplateFor = (countryCode: string): FinanceTemplate | null =>
  Object.hasOwn(TEMPLATES, countryCode) ? (TEMPLATES[countryCode] ?? null) : null

export const financeTemplateCountries = (): string[] => Object.keys(TEMPLATES)
