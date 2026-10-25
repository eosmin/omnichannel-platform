import { z } from 'zod'

import { slugify } from '@platform/core/database'
import { SUPPORTED_LOCALES } from '@platform/core/i18n'

const MAX_NAME_LENGTH = 100
const CURRENCY_CODE = /^[A-Z]{3}$/

function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// The slug of a store is made from its name, so a name that leaves nothing to make it from is refused
function hasSlug(name: string): boolean {
  try {
    slugify(name)
    return true
  } catch {
    return false
  }
}

const name = z.string().trim().min(1).max(MAX_NAME_LENGTH)
const storeName = name.refine(hasSlug, { message: 'the name needs a letter or a digit' })
const timezone = z.string().refine(isTimezone, { message: 'not a timezone' })
const currency = z.string().regex(CURRENCY_CODE)
const defaultLocale = z
  .string()
  .refine(value => SUPPORTED_LOCALES.some(locale => locale === value), {
    message: 'not a supported locale'
  })

export const idSchema = z.uuid()

export const updateOrganizationSchema = z.strictObject({ name })

export const createStoreSchema = z.strictObject({
  name: storeName,
  timezone: timezone.optional(),
  currency: currency.optional(),
  defaultLocale: defaultLocale.optional()
})

// The slug is the address of the store: it does not change when the name does
export const updateStoreSchema = z
  .strictObject({
    name: name.optional(),
    timezone: timezone.optional(),
    currency: currency.optional(),
    defaultLocale: defaultLocale.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), {
    message: 'nothing to change'
  })

export type UpdateOrganizationBody = z.output<typeof updateOrganizationSchema>
export type CreateStoreBody = z.output<typeof createStoreSchema>
export type UpdateStoreBody = z.output<typeof updateStoreSchema>
