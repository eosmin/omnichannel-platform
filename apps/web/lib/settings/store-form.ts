import type { StorePatch } from '@platform/api-client'
import { OrganizationLimits } from '@platform/core/domain'
import { SUPPORTED_LOCALES } from '@platform/core/i18n'

const CURRENCY_CODE = /^[A-Z]{3}$/

export interface StoreFormValues {
  name: string
  timezone: string
  currency: string
  defaultLocale: string
}

export const StoreFormErrors = {
  NAME_REQUIRED: 'nameRequired',
  NAME_TOO_LONG: 'nameTooLong',
  CURRENCY_INVALID: 'currencyInvalid',
  LOCALE_INVALID: 'localeInvalid'
} as const
export type StoreFormError = (typeof StoreFormErrors)[keyof typeof StoreFormErrors]

export type StoreFormProblems = Partial<Record<keyof StoreFormValues, StoreFormError>>

// What the form says is checked here as the api will check it, so that the person reads the problem
// before the request. The api still decides.
export function storeFormProblems(values: StoreFormValues): StoreFormProblems {
  const problems: StoreFormProblems = {}
  const name = values.name.trim()
  if (name.length === 0) problems.name = StoreFormErrors.NAME_REQUIRED
  else if (name.length > OrganizationLimits.NAME_MAX_LENGTH)
    problems.name = StoreFormErrors.NAME_TOO_LONG
  if (!CURRENCY_CODE.test(values.currency)) problems.currency = StoreFormErrors.CURRENCY_INVALID
  if (!SUPPORTED_LOCALES.some(locale => locale === values.defaultLocale)) {
    problems.defaultLocale = StoreFormErrors.LOCALE_INVALID
  }
  return problems
}

// Only the fields that changed: the api refuses an empty patch, and a field the person did not touch
// must not overwrite what another person saved meanwhile
export function storePatchOf(initial: StoreFormValues, values: StoreFormValues): StorePatch {
  const patch: StorePatch = {}
  if (values.name.trim() !== initial.name) patch.name = values.name.trim()
  if (values.timezone !== initial.timezone) patch.timezone = values.timezone
  if (values.currency !== initial.currency) patch.currency = values.currency
  if (values.defaultLocale !== initial.defaultLocale) patch.defaultLocale = values.defaultLocale
  return patch
}

export function hasChanges(patch: object): boolean {
  return Object.keys(patch).length > 0
}

// The zones, currencies and locales a select offers. Intl may not list them (an old browser): the
// list then holds only the current value, which the caller adds.
export function intlValues(key: 'timeZone' | 'currency'): string[] {
  try {
    return Intl.supportedValuesOf(key)
  } catch {
    return []
  }
}

// The options of a select, with the current value first-class even when the list does not hold it
export function withCurrent(options: readonly string[], current: string): string[] {
  return options.includes(current) || current === '' ? [...options] : [current, ...options]
}
