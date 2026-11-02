import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { DIGEST_LINKS, type DigestLinks } from '@platform/core/notifications'

// Where the links of the notification emails point, from the validated env (TDD_06 §6.4)
@Module({
  providers: [
    { provide: DIGEST_LINKS, useFactory: (): DigestLinks => ({ frontendUrl: env.FRONTEND_URL }) }
  ],
  exports: [DIGEST_LINKS]
})
export class DigestPlatformModule {}
