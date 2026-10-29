import { z } from 'zod'

// What the api answers, parsed at the edge: the browser never trusts a body it has not checked.
// The shapes mirror apps/api/src/modules/auth (AccountProfile, ConsumedMagicLink); a permission is
// kept as a string so that a server newer than the page cannot make the whole profile fail to parse.

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    metadata: z.record(z.string(), z.unknown()).default({})
  }),
  correlationId: z.string()
})
export type ErrorBody = z.output<typeof errorResponseSchema>

export const accountMembershipSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  role: z.string(),
  permissions: z.array(z.string())
})
export type AccountMembership = z.output<typeof accountMembershipSchema>

export const accountProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  locale: z.string(),
  timezone: z.string().nullable(),
  density: z.string(),
  memberships: z.array(accountMembershipSchema)
})
export type AccountProfile = z.output<typeof accountProfileSchema>

// What the Next server hands to the browser: the access token only. The refresh token stays in the
// httpOnly cookie that the server sets (TDD_01 §7).
export const accessSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive()
})
export type AccessSession = z.output<typeof accessSessionSchema>

export const acceptedSchema = z.object({ accepted: z.literal(true) })
