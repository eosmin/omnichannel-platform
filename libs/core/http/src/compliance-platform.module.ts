import { createHmac } from 'node:crypto'

import { Module } from '@nestjs/common'

import {
  COOKIE_CONSENT_HASH_KEY,
  DSR_CONFIG,
  type DsrConfig,
  dsrPublicFlowReady,
  dsrHashKeyOf
} from '@platform/core/compliance'
import { env } from '@platform/core/config/env'

// Keys the hash of the address of a visitor who answers the cookie banner with the secret of the validated env
@Module({
  providers: [
    {
      provide: COOKIE_CONSENT_HASH_KEY, // Derived, with its own label: the signing secret itself is never the key of anything else
      useFactory: (): string =>
        createHmac('sha256', env.JWT_SECRET).update('cookie-consent-ip-hash-key:v1').digest('hex')
    },
    {
      provide: DSR_CONFIG,
      // On only when the whole flow is ready (the env schema refuses to start otherwise; this is the second lock)
      useFactory: (): DsrConfig => ({
        enabled: env.DSR_PUBLIC_INTAKE_ENABLED && dsrPublicFlowReady(),
        hashKey: dsrHashKeyOf(env.JWT_SECRET),
        encryptionKeyHex: env.CREDENTIALS_ENCRYPTION_KEY
      })
    }
  ],
  exports: [COOKIE_CONSENT_HASH_KEY, DSR_CONFIG]
})
export class CompliancePlatformModule {}
