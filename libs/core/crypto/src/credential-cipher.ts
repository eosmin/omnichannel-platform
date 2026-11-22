import { z } from 'zod'

import { DecryptionError, DecryptionFailure, decrypt, encrypt, failureOf } from './aes-gcm'

const credentialsSchema = z.record(z.string(), z.unknown())
export type Credentials = z.output<typeof credentialsSchema>

// What a channel connection keeps of its credentials: the JSON of the object, encrypted. The key is a
// parameter of the constructor, not read here, so a test and the rotation job can hold their own.
// Which key of the cipher opened a value: the one that seals today, or the one that was replaced (a rotation of the key, Step 7.3-S11b)
export const SealedWith = { CURRENT: 'current', PREVIOUS: 'previous' } as const
export type SealedWith = (typeof SealedWith)[keyof typeof SealedWith]

export class CredentialCipher {
  // `previousKey` is held only while a rotation is finished: it opens what the key before sealed, it never seals
  constructor(
    private readonly key: Buffer,
    private readonly previousKey?: Buffer
  ) {}

  get hasPreviousKey(): boolean {
    return this.previousKey !== undefined
  }

  // With `aad` the value is bound to it (the same text is needed to open it); without, the format is the one written before
  seal(credentials: Credentials, aad?: string): Buffer<ArrayBuffer> {
    return encrypt(JSON.stringify(credentials), this.key, aad)
  }

  // The database is a boundary like any other: what comes out is checked to be an object again
  open(sealed: Uint8Array, aad?: string): Credentials {
    return this.parse(decrypt(sealed, this.key, aad))
  }

  // The open of the rotation: the current key first, then the previous one when a rotation is on. A value that opens with neither throws
  // what the CURRENT key threw (a wrong key and an altered row fail alike, so the code is `key_mismatch`): nothing is ever guessed or
  // dropped, and the caller learns which key opened it to seal it again with the current one
  openRotating(
    sealed: Uint8Array,
    aad?: string
  ): { credentials: Credentials; sealedWith: SealedWith } {
    try {
      return { credentials: this.open(sealed, aad), sealedWith: SealedWith.CURRENT }
    } catch (error) {
      const previous = this.previousKey
      // Only a failed tag can mean "another key"; a value that is not even shaped like a sealed one is damaged under any key
      if (previous === undefined || failureOf(error) !== DecryptionFailure.KEY_MISMATCH) throw error
      try {
        return {
          credentials: this.parse(decrypt(sealed, previous, aad)),
          sealedWith: SealedWith.PREVIOUS
        }
      } catch {
        throw error
      }
    }
  }

  private parse(text: string): Credentials {
    // What opened but is not a set of credentials is a damaged row; the parser's own message is dropped (it may quote the value)
    try {
      return credentialsSchema.parse(JSON.parse(text))
    } catch {
      throw new DecryptionError('not a set of credentials', DecryptionFailure.ROW_DAMAGED)
    }
  }
}
