import { createHmac } from 'node:crypto'

import {
  signUnsubscribeToken,
  UnsubscribeScopes,
  unsubscribeKeyOf,
  verifyUnsubscribeToken
} from './unsubscribe-token'

const KEY = 'k'.repeat(40)
const OTHER_KEY = 'o'.repeat(40)
const USER = 'cm1abcdefghij0123456789'

describe('unsubscribe token', () => {
  it('round-trips the scope and the id', () => {
    const token = signUnsubscribeToken(KEY, UnsubscribeScopes.NOTIFICATION_EMAIL, USER)
    expect(verifyUnsubscribeToken(KEY, token)).toEqual({
      scope: UnsubscribeScopes.NOTIFICATION_EMAIL,
      id: USER
    })
  })

  it('is the same token every time for the same input (opening it twice is the same act)', () => {
    expect(signUnsubscribeToken(KEY, 'ne', USER)).toBe(signUnsubscribeToken(KEY, 'ne', USER))
  })

  it('carries no address and no name: only the opaque id', () => {
    const token = signUnsubscribeToken(KEY, 'ne', USER)
    expect(token).not.toMatch(/[@%\s]/)
  })

  it('refuses a token made under another key', () => {
    const token = signUnsubscribeToken(OTHER_KEY, 'ne', USER)
    expect(verifyUnsubscribeToken(KEY, token)).toBeNull()
  })

  it('refuses a changed id, scope, version or mac', () => {
    const token = signUnsubscribeToken(KEY, 'ne', USER)
    const [version, scope, id, mac] = token.split('.') as [string, string, string, string]
    expect(verifyUnsubscribeToken(KEY, [version, scope, 'someone-else', mac].join('.'))).toBeNull()
    expect(verifyUnsubscribeToken(KEY, [version, 'xx', id, mac].join('.'))).toBeNull()
    expect(verifyUnsubscribeToken(KEY, ['v2', scope, id, mac].join('.'))).toBeNull()
    const flipped = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`
    expect(verifyUnsubscribeToken(KEY, [version, scope, id, flipped].join('.'))).toBeNull()
  })

  it('refuses a mac made for another purpose under the same key (domain separation)', () => {
    const foreign = createHmac('sha256', KEY).update(`ne\n${USER}`).digest('hex')
    expect(verifyUnsubscribeToken(KEY, `v1.ne.${USER}.${foreign}`)).toBeNull()
  })

  it.each([
    '',
    'v1',
    'v1.ne.id',
    'v1.ne.id.zz',
    `v1.ne.${USER}.${'z'.repeat(64)}`,
    `v1.ne.${USER}.${'0'.repeat(63)}`,
    `v1.ne.${USER}.${'0'.repeat(64)}.extra`,
    `v1.ne.a b.${'0'.repeat(64)}`,
    'x'.repeat(5000)
  ])('answers null, never throws, for the malformed input %#', input => {
    expect(verifyUnsubscribeToken(KEY, input)).toBeNull()
  })

  it('refuses to sign an id of an invalid shape', () => {
    expect(() => signUnsubscribeToken(KEY, 'ne', 'a.b')).toThrow()
    expect(() => signUnsubscribeToken(KEY, 'ne', '')).toThrow()
  })

  describe('unsubscribeKeyOf', () => {
    it('is the own key when the env sets one', () => {
      expect(unsubscribeKeyOf({ jwtSecret: 'j'.repeat(40), unsubscribeTokenKey: KEY })).toBe(KEY)
    })

    it('derives a key that is not the signing secret when the env sets none', () => {
      const jwtSecret = 'j'.repeat(40)
      const derived = unsubscribeKeyOf({ jwtSecret, unsubscribeTokenKey: undefined })
      expect(derived).not.toBe(jwtSecret)
      expect(derived).toBe(unsubscribeKeyOf({ jwtSecret, unsubscribeTokenKey: undefined }))
      expect(derived).not.toBe(
        unsubscribeKeyOf({ jwtSecret: 'x'.repeat(40), unsubscribeTokenKey: undefined })
      )
    })
  })
})
