import { z } from 'zod'

import { C807Environments, C807Parcel, C807WeightUnits } from './c807-constants'

// What the owner gives for a C807 connection: the user and password of the Basic Auth of the token, the type of delivery
// (`tipo_entrega`, "NRML" or "PLUS", enabled by the contract) and, optionally, the site (`sede`) the pickups leave from.
export const c807ConnectionSchema = z.object({
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  deliveryType: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/),
  // Left blank it is the production environment of C807
  environment: z.preprocess(
    value =>
      value === '' || value === null
        ? undefined
        : typeof value === 'string'
          ? value.trim().toLowerCase()
          : value,
    z
      .enum([C807Environments.PRODUCTION, C807Environments.SANDBOX])
      .default(C807Environments.PRODUCTION)
  ),
  // The unit C807 enabled for the account (`unidad_medida`); left blank, pounds
  weightUnit: z.preprocess(
    value =>
      value === '' || value === null
        ? undefined
        : typeof value === 'string'
          ? value.toUpperCase()
          : value,
    z
      .enum([C807WeightUnits.POUND, C807WeightUnits.KILOGRAM])
      .default(C807Parcel.DEFAULT_WEIGHT_UNIT)
  ),
  // C807 requires an e-mail for every guide: this one goes out for a customer who has none
  fallbackEmail: z.preprocess(
    value =>
      value === '' || value === null ? undefined : typeof value === 'string' ? value.trim() : value,
    z.email().max(75).optional()
  ),
  // A blank optional field of the form is no site, not a site 0
  site: z.preprocess(
    value => (value === '' || value === null ? undefined : value),
    z.coerce.number().int().positive().optional()
  )
})
export type C807Connection = z.infer<typeof c807ConnectionSchema>

// The secret part of the connection is what the carrier takes for Basic Auth
export interface C807Credentials {
  username: string
  password: string
}

// What is kept in the metadata of the connection, readable without decrypting anything
export const c807MetadataSchema = z.object({
  deliveryType: z.string().min(1),
  // A connection made before the sandbox existed has none and is production
  environment: z
    .enum([C807Environments.PRODUCTION, C807Environments.SANDBOX])
    .default(C807Environments.PRODUCTION),
  fallbackEmail: z.email().max(75).optional(),
  // A connection made before the unit was a setting weighs in pounds
  weightUnit: z
    .enum([C807WeightUnits.POUND, C807WeightUnits.KILOGRAM])
    .default(C807Parcel.DEFAULT_WEIGHT_UNIT),
  site: z.number().int().positive().optional()
})
export type C807Metadata = z.infer<typeof c807MetadataSchema>

export const C807_DISPLAY_NAME = 'C807 Express'
