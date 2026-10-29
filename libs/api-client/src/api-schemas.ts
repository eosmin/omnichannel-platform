import { z } from 'zod'

import { PresenceStatus } from '@platform/core/realtime'

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

// The page of an invitation (GET /invitations/:token), public
export const invitationPreviewSchema = z.object({
  email: z.string(),
  storeName: z.string(),
  roleName: z.string(),
  inviterName: z.string(),
  expiresAt: z.string()
})
export type InvitationPreview = z.output<typeof invitationPreviewSchema>

// What the Next server answers to an accepted invitation: the store, and a session only when the
// accept created the account
export const acceptedInvitationSchema = z.object({
  store: z.object({ id: z.string(), name: z.string() }),
  role: z.string(),
  accessToken: z.string().min(1).optional(),
  expiresIn: z.number().int().positive().optional()
})
export type AcceptedInvitation = z.output<typeof acceptedInvitationSchema>

export const storeViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  currency: z.string(),
  defaultLocale: z.string()
})
export type StoreView = z.output<typeof storeViewSchema>

// The reply a send answers with. Only what the client acts on: a server newer than the page may add
// fields, and the thread is read again through the REST api for the rest.
export const sentMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  deliveryStatus: z.string().nullable()
})
export type SentMessage = z.output<typeof sentMessageSchema>

// A status this page does not know is shown as offline instead of failing the whole list
export const userPresenceSchema = z.object({
  userId: z.string(),
  status: z.enum(PresenceStatus).catch(PresenceStatus.OFFLINE)
})
export const teamPresenceSchema = z.array(userPresenceSchema)
export type UserPresenceView = z.output<typeof userPresenceSchema>
