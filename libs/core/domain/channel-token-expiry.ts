import { z } from 'zod'

// What Meta says about the token of a connection (`GET /debug_token`), kept in `metadata.tokenInfo` of the
// connection. Never the token, nor anything made from it.
export const TokenKinds = {
  PAGE: 'page',
  USER: 'user',
  UNKNOWN: 'unknown'
} as const
export type TokenKind = (typeof TokenKinds)[keyof typeof TokenKinds]

// What the card of a connection says about it. `unknown` is what is said when Meta could not be asked or
// did not answer: it is never `expired`, which is said only when Meta gave a date that has passed.
export const TokenExpiryStates = {
  NEVER: 'never',
  EXPIRES: 'expires',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  UNKNOWN: 'unknown'
} as const
export type TokenExpiryState = (typeof TokenExpiryStates)[keyof typeof TokenExpiryStates]

// The key of the metadata of a connection that holds `TokenInfo`
export const ChannelMetadataKeys = {
  TOKEN_INFO: 'tokenInfo',
  // When the provider was last asked about the token, whatever the answer was (or whether there was one): a
  // connection that cannot be asked about is not asked again at once, and cannot crowd out the rest
  TOKEN_ATTEMPT_AT: 'tokenAttemptAt'
} as const

// The keys inside `tokenInfo` that the SQL of the write names: a rename of a field of the schema must not
// compile without them (and the spec compares them with the schema)
export const TokenInfoKeys = {
  EXPIRES_AT: 'expiresAt',
  EXPIRY_NOTIFIED_FOR: 'expiryNotifiedFor'
} as const satisfies Record<string, keyof TokenInfo>

export const TokenExpiryLimits = {
  // The people who set up the channels are told when the token has this many days left
  WARN_DAYS: 7,
  // A connection is asked about at most this often...
  RECHECK_HOURS: 20,
  // ...and one whose token does not expire, this often
  RECHECK_NEVER_DAYS: 7,
  // Calls to Meta one round of the daily job makes, at most
  RUN_MAX_CALLS: 100,
  REQUEST_TIMEOUT_MS: 10_000,
  // A round of the daily job stops starting questions after this long
  ROUND_BUDGET_MS: 300_000,
  SCOPES_MAX: 100,
  SCOPE_MAX_LENGTH: 100
} as const

const isoDate = z.iso.datetime()

export const tokenInfoSchema = z.object({
  kind: z.enum(TokenKinds),
  isValid: z.boolean(),
  // null: the token does not expire
  expiresAt: isoDate.nullable(),
  scopes: z
    .array(z.string().max(TokenExpiryLimits.SCOPE_MAX_LENGTH))
    .max(TokenExpiryLimits.SCOPES_MAX),
  checkedAt: isoDate,
  // The expiry the people were told about, so that each date is announced once; renewing the token changes
  // the date and so arms the notice again
  expiryNotifiedFor: isoDate.nullable()
})
export type TokenInfo = z.infer<typeof tokenInfoSchema>

// What a plugin answers when it is asked about its token
export interface TokenInspection {
  kind: TokenKind
  isValid: boolean
  expiresAt: Date | null
  scopes: string[]
}

// What the api shows of it, in the view of a connection
export interface TokenExpiryView {
  state: TokenExpiryState
  expiresAt: string | null
  checkedAt: string | null
  kind: TokenKind
}

// The metadata of a connection is plain JSON that more than one writer touches: what does not parse is
// no information, not an error.
export function readTokenInfo(metadata: unknown): TokenInfo | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const parsed = tokenInfoSchema.safeParse(
    (metadata as Record<string, unknown>)[ChannelMetadataKeys.TOKEN_INFO]
  )
  return parsed.success ? parsed.data : null
}

export function tokenExpiryOf(info: TokenInfo | null, now: Date): TokenExpiryView {
  if (info === null) {
    return {
      state: TokenExpiryStates.UNKNOWN,
      expiresAt: null,
      checkedAt: null,
      kind: TokenKinds.UNKNOWN
    }
  }
  const base = { expiresAt: info.expiresAt, checkedAt: info.checkedAt, kind: info.kind }
  if (!info.isValid) return { ...base, state: TokenExpiryStates.INVALID }
  if (info.expiresAt === null) return { ...base, state: TokenExpiryStates.NEVER }
  return {
    ...base,
    state:
      new Date(info.expiresAt).getTime() <= now.getTime()
        ? TokenExpiryStates.EXPIRED
        : TokenExpiryStates.EXPIRES
  }
}

// Whether the people who set the channel up are to be told now: the token will stop within the warning
// time, has not stopped yet, and this date was not announced
export function isExpiryNoticeDue(info: TokenInfo, now: Date): boolean {
  if (!info.isValid || info.expiresAt === null) return false
  const left = new Date(info.expiresAt).getTime() - now.getTime()
  if (left <= 0 || left > TokenExpiryLimits.WARN_DAYS * 86_400_000) return false
  return info.expiryNotifiedFor !== info.expiresAt
}

// Whether the job asks Meta about the connection again: never asked, or asked longer ago than the window
// of its state (a token that does not expire is asked about less often)
export function isRecheckDue(info: TokenInfo | null, attemptAt: string | null, now: Date): boolean {
  const last = lastAskedAt(info, attemptAt)
  if (last === null) return true
  // A token that does not expire is asked about less often, but only while the last question was answered
  const answered = info !== null && (attemptAt === null || attemptAt <= info.checkedAt)
  const hours =
    answered && info.isValid && info.expiresAt === null
      ? TokenExpiryLimits.RECHECK_NEVER_DAYS * 24
      : TokenExpiryLimits.RECHECK_HOURS
  return now.getTime() - last >= hours * 3_600_000
}

// The last time the provider was asked, answered or not (ms); null if never
export function lastAskedAt(info: TokenInfo | null, attemptAt: string | null): number | null {
  const times = [info?.checkedAt ?? null, attemptAt]
    .filter((time): time is string => time !== null)
    .map(time => new Date(time).getTime())
    .filter(time => Number.isFinite(time))
  return times.length === 0 ? null : Math.max(...times)
}

// The time of the last question, from the metadata of a connection
export function readTokenAttemptAt(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const parsed = isoDate.safeParse(
    (metadata as Record<string, unknown>)[ChannelMetadataKeys.TOKEN_ATTEMPT_AT]
  )
  return parsed.success ? parsed.data : null
}
