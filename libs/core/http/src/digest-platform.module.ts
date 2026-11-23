import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { unsubscribeKeyOf } from '@platform/core/crypto'
import {
  DIGEST_LINKS,
  type DigestLinks,
  UNSUBSCRIBE_LINKS,
  type UnsubscribeLinks
} from '@platform/core/notifications'

import { buildUnsubscribeLinks } from './unsubscribe-links'

// Where the links of the notification emails point, from the validated env (TDD_06 §6.4), and the signed links of the one-click unsubscribe
// (Step 7.3, B6b-3b2b). The signing key is the one in force: the previous key of a rotation only verifies, in the api.
@Module({
  providers: [
    { provide: DIGEST_LINKS, useFactory: (): DigestLinks => ({ frontendUrl: env.FRONTEND_URL }) },
    {
      provide: UNSUBSCRIBE_LINKS,
      useFactory: (): UnsubscribeLinks =>
        buildUnsubscribeLinks({
          frontendUrl: env.FRONTEND_URL,
          apiUrl: env.API_URL,
          signingKey: unsubscribeKeyOf({
            jwtSecret: env.JWT_SECRET,
            unsubscribeTokenKey: env.UNSUBSCRIBE_TOKEN_KEY
          })
        })
    }
  ],
  exports: [DIGEST_LINKS, UNSUBSCRIBE_LINKS]
})
export class DigestPlatformModule {}
