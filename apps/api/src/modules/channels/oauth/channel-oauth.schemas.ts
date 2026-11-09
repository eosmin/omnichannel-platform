import { z } from 'zod'

import { ASSET_ID_MAX_LENGTH, ChannelOAuthLimits } from '@platform/core/domain'

// Opaque values made of random bytes, in base64url: 43 characters of that alphabet for 32 bytes, and nothing
// else. Each is sized by its own constant, so that changing one never makes the other fail in silence.
const base64urlLength = (bytes: number): number => Math.ceil((bytes * 8) / 6)
const opaque = (bytes: number): RegExp => new RegExp(`^[A-Za-z0-9_-]{${base64urlLength(bytes)}}$`)
export const STATE_PATTERN = opaque(ChannelOAuthLimits.STATE_BYTES)
export const SESSION_ID_PATTERN = opaque(ChannelOAuthLimits.SESSION_ID_BYTES)
export const oauthSessionIdSchema = z.string().regex(SESSION_ID_PATTERN)

// Starting a login: nothing, or the connection to repair (a uuid; the store and the plugin are checked against it)
// No body at all is a login that repairs nothing (the framework leaves the body undefined)
export const startOAuthSchema = z.strictObject({ connectionId: z.uuid().optional() }).optional()
export type StartOAuthBody = z.output<typeof startOAuthSchema>

// The account the person chose, or the id they typed. The shape is the plugin's (its declared pattern, which the
// service applies); here only a bound, so nothing long reaches the pattern
export const completeOAuthSchema = z.strictObject({
  assetId: z.string().min(1).max(ASSET_ID_MAX_LENGTH)
})
export type CompleteOAuthBody = z.output<typeof completeOAuthSchema>
