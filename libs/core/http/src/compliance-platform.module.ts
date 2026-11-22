import { Module } from '@nestjs/common'

import {
  COOKIE_CONSENT_HASH_KEY,
  COOKIE_CONSENT_RETENTION_ENABLED,
  type ConsentHashKey,
  consentHashKeyOf,
  DSR_CONFIG,
  type DsrConfig,
  dsrPublicFlowReady,
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
          consentHashKey: env.CONSENT_HASH_KEY
        })
    },
    {
      // Off by default: the sweep of the old answers to the banner destroys evidence of consent, and the owner turns it on
      provide: COOKIE_CONSENT_RETENTION_ENABLED,
      useFactory: (): boolean => env.COOKIE_CONSENT_RETENTION_ENABLED
    },
    {
      provide: DSR_CONFIG,
      // On only when the whole flow is ready (the env schema refuses to start otherwise; this is the second lock)
      useFactory: (): DsrConfig => ({
        enabled: env.DSR_PUBLIC_INTAKE_ENABLED && dsrPublicFlowReady(),
        hashKey: dsrHashKeyOf(env.JWT_SECRET),
        encryptionKeyHex: env.CREDENTIALS_ENCRYPTION_KEY,
        ...(env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS === undefined
          ? {}
          : { previousEncryptionKeyHex: env.CREDENTIALS_ENCRYPTION_KEY_PREVIOUS })
      })
    }
  ],
  exports: [COOKIE_CONSENT_HASH_KEY, COOKIE_CONSENT_RETENTION_ENABLED, DSR_CONFIG]
})
export class CompliancePlatformModule {}
