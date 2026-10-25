import { z } from 'zod'

// 254 is the longest address SMTP allows (RFC 5321); a longer one cannot exist
const MAX_EMAIL_LENGTH = 254
// Tokens are 256 bits in base64url (43 characters); the cap only keeps a hostile body from being hashed
const MAX_TOKEN_LENGTH = 200

export const magicLinkRequestSchema = z.object({ email: z.email().max(MAX_EMAIL_LENGTH) })
export const magicLinkConsumeSchema = z.object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) })
export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(MAX_TOKEN_LENGTH) })
export const sessionIdSchema = z.uuid()

export type MagicLinkRequestBody = z.output<typeof magicLinkRequestSchema>
export type MagicLinkConsumeBody = z.output<typeof magicLinkConsumeSchema>
export type RefreshBody = z.output<typeof refreshSchema>
