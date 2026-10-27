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
})
