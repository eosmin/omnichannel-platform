import { z } from 'zod'

// Tokens are 256 bits in base64url (43 characters); the cap only keeps a hostile path from being hashed
const MAX_TOKEN_LENGTH = 200
const MAX_NAME_LENGTH = 100

export const invitationTokenSchema = z.string().min(1).max(MAX_TOKEN_LENGTH)

// The name is only needed when the accept creates the account; the address is the one invited and
// is never taken from the body
export const acceptInvitationSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional()
})

export type AcceptInvitationBody = z.output<typeof acceptInvitationSchema>
