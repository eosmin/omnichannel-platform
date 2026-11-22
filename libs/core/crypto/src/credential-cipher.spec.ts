import { randomBytes } from 'node:crypto'

import { DecryptionError, DecryptionFailure, encrypt, failureOf } from './aes-gcm'
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

  describe('why a value did not open (Step 7.3-S11a)', () => {
    const failureOfOpen = (
      open: () => unknown
    ): { failure: DecryptionFailure; message: string } => {
      try {
        open()
      } catch (error) {
        return { failure: failureOf(error), message: (error as Error).message }
      }
      throw new Error('it opened')
    }

    it('says KEY_MISMATCH for another key or an altered value, never with data', () => {
      const other = new CredentialCipher(randomBytes(32))
      const sealed = other.seal({ taxId: 'TAX-SECRET-77' })
      const wrongKey = failureOfOpen(() => cipher.open(sealed))
      expect(wrongKey.failure).toBe(DecryptionFailure.KEY_MISMATCH)
      const altered = Buffer.from(cipher.seal({ taxId: 'TAX-SECRET-77' }))
      altered[altered.length - 20] = (altered[altered.length - 20] ?? 0) ^ 0xff
      const tampered = failureOfOpen(() => cipher.open(altered))
      expect(tampered.failure).toBe(DecryptionFailure.KEY_MISMATCH)
      expect(wrongKey.message + tampered.message).not.toContain('TAX-SECRET')
    })

    it('says ROW_DAMAGED for bytes that are not a sealed value or not credentials', () => {
      expect(failureOfOpen(() => cipher.open(Buffer.from([1, 2, 3]))).failure).toBe(
        DecryptionFailure.ROW_DAMAGED
      )
      const key = randomBytes(32)
      const notObject = failureOfOpen(() => new CredentialCipher(key).open(encrypt('[1,2]', key)))
      expect(notObject.failure).toBe(DecryptionFailure.ROW_DAMAGED)
      const notJson = failureOfOpen(() =>
        new CredentialCipher(key).open(encrypt('TAX-SECRET-77 {', key))
      )
      expect(notJson.failure).toBe(DecryptionFailure.ROW_DAMAGED)
      expect(notJson.message).not.toContain('TAX-SECRET')
    })

    it('says KEY_MISSING when there is no usable key', () => {
      const sealed = cipher.seal({ a: 'b' })
      expect(failureOfOpen(() => new CredentialCipher(Buffer.alloc(0)).open(sealed)).failure).toBe(
        DecryptionFailure.KEY_MISSING
      )
    })
  })
})
