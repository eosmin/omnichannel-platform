import { z } from 'zod'

import {
  AccountLimits,
  singleLineText,
  timezoneSchema,
  UiDensity,
  type UiDensityType
} from '@platform/core/domain'
import { SUPPORTED_LOCALES } from '@platform/core/i18n'

const hasAField = (body: object): boolean => Object.values(body).some(value => value !== undefined)
const NOTHING_TO_CHANGE = { message: 'nothing to change' }

// The person changes their own name and picture. `avatarMediaId` is the id of an upload the person
// made for the purpose avatar (the service checks it is theirs); null takes the picture away.
export const updateProfileSchema = z
  .strictObject({
    name: singleLineText(AccountLimits.NAME_MAX_LENGTH, 1).optional(),
    avatarMediaId: z.uuid().nullable().optional()
  })
  .refine(hasAField, NOTHING_TO_CHANGE)

const density = z.enum(Object.values(UiDensity) as [UiDensityType, ...UiDensityType[]])

// Only the locales the app has messages for; a timezone is a zone of the IANA database in its
// canonical spelling, and null goes back to "use the browser's".
export const updateAccountPreferencesSchema = z
  .strictObject({
    locale: z
      .string()
      .refine(value => SUPPORTED_LOCALES.some(locale => locale === value), {
        message: 'not a supported locale'
      })
      .optional(),
    timezone: timezoneSchema.nullable().optional(),
    density: density.optional()
  })
  .refine(hasAField, NOTHING_TO_CHANGE)

export type UpdateProfileBody = z.output<typeof updateProfileSchema>
export type UpdateAccountPreferencesBody = z.output<typeof updateAccountPreferencesSchema>
