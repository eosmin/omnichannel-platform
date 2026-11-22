import { z } from 'zod'

import { slugify } from '@platform/core/database'
import {
  isSupportedCurrency,
  lowercasedUuidSchema,
  OrganizationLimits,
  singleLineText,
  timezoneSchema
} from '@platform/core/domain'
import { SUPPORTED_LOCALES } from '@platform/core/i18n'

// The slug of a store is made from its name, so a name that leaves nothing to make it from is refused
function hasSlug(name: string): boolean {
  try {
    slugify(name)
    return true
  } catch {
    return false
  }
}

const name = singleLineText(OrganizationLimits.NAME_MAX_LENGTH, 1)
const storeName = name.refine(hasSlug, { message: 'the name needs a letter or a digit' })
const timezone = timezoneSchema
const currency = z.string().refine(isSupportedCurrency, { message: 'a current ISO 4217 currency' })
const defaultLocale = z
  .string()
  .refine(value => SUPPORTED_LOCALES.some(locale => locale === value), {
    message: 'not a supported locale'
  })

export const idSchema = lowercasedUuidSchema

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

// What a person typed to confirm: the name of the store, as the screen asks for it. The api asks for it
// too, because the screen is not the only thing that can send a delete (ORG-03).
export const deleteStoreSchema = z.strictObject({
  confirmation: z.string().max(OrganizationLimits.NAME_MAX_LENGTH * 2)
})
export type DeleteStoreBody = z.output<typeof deleteStoreSchema>
