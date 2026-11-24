import { createHmac } from 'node:crypto'

import {
  signUnsubscribeToken,
  UnsubscribeScopes,
  unsubscribeKeyOf,
  unsubscribeVerificationKeys,
  verifyUnsubscribeToken,
  verifyUnsubscribeTokenUnderKeys
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

  it('accepts only the canonical spelling of the mac: upper case is a second token for the same act (BAJ-MAC)', () => {
    let tried = 0
    for (let index = 0; index < 20; index += 1) {
      const token = signUnsubscribeToken(KEY, 'ne', `${USER}${index}`)
      const [version, scope, id, mac] = token.split('.') as [string, string, string, string]
      expect(verifyUnsubscribeToken(KEY, token)).not.toBeNull()
      // A mac with no letter in it has no upper-case spelling
      if (mac.toUpperCase() === mac) continue
      tried += 1
      const upper = [version, scope, id, mac.toUpperCase()].join('.')
      const mixed = [version, scope, id, `${mac.slice(0, 32)}${mac.slice(32).toUpperCase()}`].join(
        '.'
      )
      expect(verifyUnsubscribeToken(KEY, upper)).toBeNull()
      expect(verifyUnsubscribeToken(KEY, mixed)).toBeNull()
    }
    expect(tried).toBeGreaterThan(0)
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

describe('the previous key of a rotation', () => {
  const JWT = 'j'.repeat(40)
  const NEW_KEY = 'n'.repeat(40)
  const OLD_KEY = 'p'.repeat(40)

  it('verifies a link signed under the old key while a rotation is open', () => {
    const oldLink = signUnsubscribeToken(OLD_KEY, 'ne', USER)
    const keys = unsubscribeVerificationKeys({
      jwtSecret: JWT,
      unsubscribeTokenKey: NEW_KEY,
      unsubscribeTokenKeyPrevious: OLD_KEY
    })
    expect(verifyUnsubscribeTokenUnderKeys(keys, oldLink)).toEqual({ scope: 'ne', id: USER })
  })

  it('does not verify the old link once the previous key is gone', () => {
    const oldLink = signUnsubscribeToken(OLD_KEY, 'ne', USER)
    const keys = unsubscribeVerificationKeys({
      jwtSecret: JWT,
      unsubscribeTokenKey: NEW_KEY,
      unsubscribeTokenKeyPrevious: undefined
    })
    expect(keys).toEqual([NEW_KEY])
    expect(verifyUnsubscribeTokenUnderKeys(keys, oldLink)).toBeNull()
  })

  it('still verifies the links of the key in force, and refuses a key that is neither', () => {
    const keys = unsubscribeVerificationKeys({
      jwtSecret: JWT,
      unsubscribeTokenKey: NEW_KEY,
      unsubscribeTokenKeyPrevious: OLD_KEY
    })
    expect(
      verifyUnsubscribeTokenUnderKeys(keys, signUnsubscribeToken(NEW_KEY, 'ne', USER))
    ).toEqual({
      scope: 'ne',
      id: USER
    })
    expect(
      verifyUnsubscribeTokenUnderKeys(keys, signUnsubscribeToken(OTHER_KEY, 'ne', USER))
    ).toBeNull()
  })

  it('lists the key in force first and never lists the same key twice', () => {
    expect(
      unsubscribeVerificationKeys({
        jwtSecret: JWT,
        unsubscribeTokenKey: NEW_KEY,
        unsubscribeTokenKeyPrevious: OLD_KEY
      })
    ).toEqual([NEW_KEY, OLD_KEY])
    expect(
      unsubscribeVerificationKeys({
        jwtSecret: JWT,
        unsubscribeTokenKey: NEW_KEY,
        unsubscribeTokenKeyPrevious: NEW_KEY
      })
    ).toEqual([NEW_KEY])
  })

  it('a token signed under the derived key of JWT_SECRET is the one in force where no key is set', () => {
    const derived = unsubscribeKeyOf({ jwtSecret: JWT, unsubscribeTokenKey: undefined })
    const keys = unsubscribeVerificationKeys({
      jwtSecret: JWT,
      unsubscribeTokenKey: undefined,
      unsubscribeTokenKeyPrevious: OLD_KEY
    })
    expect(keys).toEqual([derived, OLD_KEY])
  })
})
