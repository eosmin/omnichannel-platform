import type { TokenExpiryView } from './channels-requests'

// The states and the kind of token that the card of a connection reads, and the days before which it warns. A
// copy of `TokenExpiryStates`, `TokenKinds` and `TokenExpiryLimits.WARN_DAYS` of `@platform/core/domain`, which the
// browser does not import for this: that module builds a schema when it is loaded and rides in a chunk of the
// inbox. `token-expiry.spec.ts` keeps the copy equal to the original.
export const TokenStates = {
  NEVER: 'never',
  EXPIRES: 'expires',
  EXPIRED: 'expired',
  INVALID: 'invalid',
  UNKNOWN: 'unknown'
} as const
export const USER_TOKEN_KIND = 'user'
export const TOKEN_WARN_DAYS = 7

const DAY_MS = 86_400_000

// What the card says about the token: one thing about when it stops (or nothing), and whether what was pasted is
// the token of a person. Nothing is said for `unknown`, which is not "expired": the provider was never asked, or
// could not be.
export type TokenNotice =
  | { when: 'none' | 'never' | 'invalid' | 'expiredUnknownDate'; date: null; userToken: boolean }
  | { when: 'expires' | 'soon' | 'expired'; date: Date; userToken: boolean }

export function tokenNotice(view: TokenExpiryView, now: Date): TokenNotice {
  const userToken = view.kind === USER_TOKEN_KIND
  const date = view.expiresAt === null ? null : new Date(view.expiresAt)
  const known = date !== null && !Number.isNaN(date.getTime())
  switch (view.state) {
    case TokenStates.NEVER:
      return { when: 'never', date: null, userToken }
    case TokenStates.INVALID:
      return { when: 'invalid', date: null, userToken }
    case TokenStates.EXPIRED:
      return known
        ? { when: 'expired', date, userToken }
        : { when: 'expiredUnknownDate', date: null, userToken }
    case TokenStates.EXPIRES:
      if (!known) return { when: 'none', date: null, userToken }
      // The server decided the state when it answered; the page may be older than that, so a date that has passed
      // since is told as expired, not as a warning.
      if (date.getTime() <= now.getTime()) return { when: 'expired', date, userToken }
      return {
        when: date.getTime() - now.getTime() <= TOKEN_WARN_DAYS * DAY_MS ? 'soon' : 'expires',
        date,
        userToken
      }
    default:
      return { when: 'none', date: null, userToken }
  }
}
