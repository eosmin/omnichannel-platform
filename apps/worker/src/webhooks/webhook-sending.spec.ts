import { CredentialCipher, SealedWith } from '@platform/core/crypto'

import { openSecret, UnreadableSecret } from './webhook-sending'

// The secret of a webhook opens with the current key, or with the previous one while a rotation of the key is on (Step 7.3-S11c)
describe('openSecret', () => {
  const oldKey = Buffer.alloc(32, 3)
  const newKey = Buffer.alloc(32, 4)

  it('opens a secret sealed with the previous key during the rotation, and not without a previous key', () => {
    const sealed = new CredentialCipher(oldKey).seal({ secret: 'whsec' })
    expect(openSecret(new CredentialCipher(newKey, oldKey), sealed)).toBe('whsec')
    expect(() => openSecret(new CredentialCipher(newKey), sealed)).toThrow(UnreadableSecret)
  })

  it('opens a secret sealed with the current key', () => {
    const cipher = new CredentialCipher(newKey, oldKey)
    expect(openSecret(cipher, cipher.seal({ secret: 'whsec' }))).toBe('whsec')
    expect(cipher.openRotating(cipher.seal({ secret: 'x' })).sealedWith).toBe(SealedWith.CURRENT)
  })
})
