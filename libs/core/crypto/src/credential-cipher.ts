import { z } from 'zod'

import { decrypt, encrypt } from './aes-gcm'

const credentialsSchema = z.record(z.string(), z.unknown())
export type Credentials = z.output<typeof credentialsSchema>

// What a channel connection keeps of its credentials: the JSON of the object, encrypted. The key is a
// parameter of the constructor, not read here, so a test and the rotation job can hold their own.
export class CredentialCipher {
  constructor(private readonly key: Buffer) {}

  seal(credentials: Credentials): Buffer<ArrayBuffer> {
    return encrypt(JSON.stringify(credentials), this.key)
  }

  // The database is a boundary like any other: what comes out is checked to be an object again
  open(sealed: Uint8Array): Credentials {
    return credentialsSchema.parse(JSON.parse(decrypt(sealed, this.key)))
  }
}
