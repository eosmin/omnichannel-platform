import { z } from 'zod'

import { ChannelOAuthLimits, MetaOAuth } from '@platform/core/domain'

// Opaque values made of random bytes, in base64url: 43 characters of that alphabet for 32 bytes, and nothing
// else. Each is sized by its own constant, so that changing one never makes the other fail in silence.
const base64urlLength = (bytes: number): number => Math.ceil((bytes * 8) / 6)
const opaque = (bytes: number): RegExp => new RegExp(`^[A-Za-z0-9_-]{${base64urlLength(bytes)}}$`)
export const STATE_PATTERN = opaque(ChannelOAuthLimits.STATE_BYTES)
export const SESSION_ID_PATTERN = opaque(ChannelOAuthLimits.SESSION_ID_BYTES)
export const oauthSessionIdSchema = z.string().regex(SESSION_ID_PATTERN)

// The Page the person chose, or the number of the Page they typed: only digits, because it goes into a path
export const completeOAuthSchema = z.strictObject({
  assetId: z.string().regex(MetaOAuth.ASSET_ID_PATTERN)
})
export type CompleteOAuthBody = z.output<typeof completeOAuthSchema>
