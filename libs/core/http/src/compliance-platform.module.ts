import { Module } from '@nestjs/common'

import {
  COOKIE_CONSENT_HASH_KEY,
  type ConsentHashKey,
  consentHashKeyOf,
  DSR_CONFIG,
  type DsrConfig,
  dsrExecutorAvailable,
  dsrHashKeyOf
} from '@platform/core/compliance'
import { env } from '@platform/core/config/env'

// Keys the hash of the address of a visitor who answers the cookie banner: its own key (`CONSENT_HASH_KEY`), or, where the env sets none
// (a laptop, a test run: a deployed environment is refused without it), one derived from the signing secret
@Module({
  providers: [
    {
      provide: COOKIE_CONSENT_HASH_KEY,
      useFactory: (): ConsentHashKey =>
        consentHashKeyOf({
          jwtSecret: env.JWT_SECRET,
          consentHashKey: env.CONSENT_HASH_KEY,
          consentHashKeyId: env.CONSENT_HASH_KEY_ID
        })
    },
    {
      provide: DSR_CONFIG,
      // On only with the executor of erasures in place (the env schema refuses to start otherwise; this is the second lock)
      useFactory: (): DsrConfig => ({
        enabled: env.DSR_PUBLIC_INTAKE_ENABLED && dsrExecutorAvailable(),
        hashKey: dsrHashKeyOf(env.JWT_SECRET),
        encryptionKeyHex: env.CREDENTIALS_ENCRYPTION_KEY
      })
    }
  ],
  exports: [COOKIE_CONSENT_HASH_KEY, DSR_CONFIG]
})
export class CompliancePlatformModule {}
