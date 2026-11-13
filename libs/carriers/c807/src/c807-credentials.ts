import { z } from 'zod'

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
  site: z.number().int().positive().optional()
})
export type C807Metadata = z.infer<typeof c807MetadataSchema>

export const C807_DISPLAY_NAME = 'C807 Express'
