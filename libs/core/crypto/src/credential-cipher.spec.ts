import { randomBytes } from 'node:crypto'

import { DecryptionError, encrypt } from './aes-gcm'
import { CredentialCipher } from './credential-cipher'

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher(randomBytes(32))

  it('gives back what it sealed', () => {
    const credentials = { accessToken: 'secret-token', nested: { phoneId: '123' } }
    expect(cipher.open(cipher.seal(credentials))).toEqual(credentials)
  })

  it('keeps the secret out of the stored bytes', () => {
    expect(cipher.seal({ accessToken: 'secret-token' }).toString('utf8')).not.toContain(
      'secret-token'
    )
  })

  it('does not open what another key sealed', () => {
    const other = new CredentialCipher(randomBytes(32))
    expect(() => cipher.open(other.seal({ a: 'b' }))).toThrow(DecryptionError)
  })

  it('refuses a sealed value that is not an object', () => {
    // Sealed by hand: a list is not a set of credentials
    const key = randomBytes(32)
    expect(() => new CredentialCipher(key).open(encrypt('[1,2]', key))).toThrow()
  })

  describe('associated data', () => {
    it('opens a bound value only with the data it was sealed with', () => {
      const sealed = cipher.seal({ a: 'b' }, 'store-1:invitation-1')
      expect(cipher.open(sealed, 'store-1:invitation-1')).toEqual({ a: 'b' })
      expect(() => cipher.open(sealed, 'store-1:invitation-2')).toThrow(DecryptionError)
      expect(() => cipher.open(sealed, 'store-2:invitation-1')).toThrow(DecryptionError)
      expect(() => cipher.open(sealed)).toThrow(DecryptionError)
    })

    it('still opens a value sealed before the data existed (format 1), with or without data', () => {
      const key = randomBytes(32)
      const legacy = encrypt('{"a":"b"}', key)
      expect(legacy[0]).toBe(1)
      expect(new CredentialCipher(key).open(legacy)).toEqual({ a: 'b' })
      expect(new CredentialCipher(key).open(legacy, 'store-1:invitation-1')).toEqual({ a: 'b' })
    })

    it('writes format 2 only when it is given data', () => {
      expect(cipher.seal({ a: 'b' }, 'x')[0]).toBe(2)
      expect(cipher.seal({ a: 'b' })[0]).toBe(1)
    })

    it('does not open a bound value whose format byte was lowered to 1', () => {
      const sealed = cipher.seal({ a: 'b' }, 'x')
      sealed[0] = 1
      expect(() => cipher.open(sealed, 'x')).toThrow(DecryptionError)
    })
  })
})
