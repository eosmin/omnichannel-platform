import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { unsubscribeVerificationKeys } from '@platform/core/crypto'
import { UNSUBSCRIBE_VERIFICATION_KEYS } from '@platform/core/notifications'

// The keys the api verifies the unsubscribe links with: the one in force and, while a rotation is open, the previous one (it only verifies)
@Module({
  providers: [
    {
      provide: UNSUBSCRIBE_VERIFICATION_KEYS,
      useFactory: (): readonly string[] =>
        unsubscribeVerificationKeys({
          jwtSecret: env.JWT_SECRET,
          unsubscribeTokenKey: env.UNSUBSCRIBE_TOKEN_KEY,
          unsubscribeTokenKeyPrevious: env.UNSUBSCRIBE_TOKEN_KEY_PREVIOUS
        })
    }
  ],
  exports: [UNSUBSCRIBE_VERIFICATION_KEYS]
})
export class UnsubscribePlatformModule {}
