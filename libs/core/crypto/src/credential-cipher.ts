import { z } from 'zod'

import { DecryptionError, DecryptionFailure, decrypt, encrypt } from './aes-gcm'

const credentialsSchema = z.record(z.string(), z.unknown())
export type Credentials = z.output<typeof credentialsSchema>

// What a channel connection keeps of its credentials: the JSON of the object, encrypted. The key is a
// parameter of the constructor, not read here, so a test and the rotation job can hold their own.
export class CredentialCipher {
  constructor(private readonly key: Buffer) {}

  // With `aad` the value is bound to it (the same text is needed to open it); without, the format is the one written before
  seal(credentials: Credentials, aad?: string): Buffer<ArrayBuffer> {
    return encrypt(JSON.stringify(credentials), this.key, aad)
  }

  // The database is a boundary like any other: what comes out is checked to be an object again
  open(sealed: Uint8Array, aad?: string): Credentials {
    const text = decrypt(sealed, this.key, aad)
    // What opened but is not a set of credentials is a damaged row; the parser's own message is dropped (it may quote the value)
    try {
      return credentialsSchema.parse(JSON.parse(text))
    } catch {
      throw new DecryptionError('not a set of credentials', DecryptionFailure.ROW_DAMAGED)
    }
  }
}
