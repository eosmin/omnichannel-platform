import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'

// The cipher of the credentials of the channels, keyed from the validated env
@Module({
  providers: [
    {
      provide: CredentialCipher,
      useFactory: () => new CredentialCipher(parseEncryptionKey(env.CREDENTIALS_ENCRYPTION_KEY))
    }
  ],
  exports: [CredentialCipher]
})
export class CryptoPlatformModule {}
