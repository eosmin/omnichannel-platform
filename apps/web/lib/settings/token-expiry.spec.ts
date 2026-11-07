import { TokenExpiryLimits, TokenExpiryStates, TokenKinds } from '@platform/core/domain'

import type { TokenExpiryView } from './channels-requests'
import { TOKEN_WARN_DAYS, TokenStates, tokenNotice, USER_TOKEN_KIND } from './token-expiry'

const NOW = new Date('2026-11-07T12:00:00.000Z')
const DAY = 86_400_000
const view = (over: Partial<TokenExpiryView>): TokenExpiryView => ({
  state: 'unknown',
  expiresAt: null,
  checkedAt: null,
  kind: 'page',
  ...over
})
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString()

describe('the copy of the token states that the browser reads', () => {
  it('is the server’s', () => {
    expect(TokenStates).toEqual(TokenExpiryStates)
    expect(USER_TOKEN_KIND).toBe(TokenKinds.USER)
    expect(TOKEN_WARN_DAYS).toBe(TokenExpiryLimits.WARN_DAYS)
  })
})

describe('tokenNotice', () => {
  it('says nothing while it is not known', () => {
    expect(tokenNotice(view({}), NOW)).toEqual({ when: 'none', date: null, userToken: false })
    // A state this page does not know (a server newer than the page) is not "expired" either
    expect(tokenNotice(view({ state: 'something-new', expiresAt: at(-DAY) }), NOW).when).toBe(
      'none'
    )
  })

  it('tells a token that does not expire and one that is not valid', () => {
    expect(tokenNotice(view({ state: 'never' }), NOW).when).toBe('never')
    expect(tokenNotice(view({ state: 'invalid', expiresAt: at(DAY) }), NOW)).toEqual({
      when: 'invalid',
      date: null,
      userToken: false
    })
  })

  it('tells the date, and warns from the days before it that the server warns', () => {
    const far = tokenNotice(
      view({ state: 'expires', expiresAt: at(TOKEN_WARN_DAYS * DAY + 1000) }),
      NOW
    )
    const near = tokenNotice(view({ state: 'expires', expiresAt: at(TOKEN_WARN_DAYS * DAY) }), NOW)
    expect(far.when).toBe('expires')
    expect(near.when).toBe('soon')
    expect(near.date?.toISOString()).toBe(at(TOKEN_WARN_DAYS * DAY))
  })

  it('tells a token that expired, with its date, and ignores a date it cannot read', () => {
    expect(tokenNotice(view({ state: 'expired', expiresAt: at(-DAY) }), NOW).when).toBe('expired')
    expect(tokenNotice(view({ state: 'expires', expiresAt: 'yesterday' }), NOW).when).toBe('none')
    expect(tokenNotice(view({ state: 'expired', expiresAt: null }), NOW).when).toBe(
      'expiredUnknownDate'
    )
    // The page outlived the date: told as expired, not as a warning.
    expect(tokenNotice(view({ state: 'expires', expiresAt: at(-DAY) }), NOW).when).toBe('expired')
  })

  it('says that a token of a person was pasted, whatever else is known', () => {
    expect(tokenNotice(view({ kind: 'user' }), NOW)).toMatchObject({
      when: 'none',
      userToken: true
    })
    expect(tokenNotice(view({ kind: 'user', state: 'never' }), NOW)).toMatchObject({
      when: 'never',
      userToken: true
    })
    expect(tokenNotice(view({ kind: 'page', state: 'never' }), NOW).userToken).toBe(false)
  })
})
