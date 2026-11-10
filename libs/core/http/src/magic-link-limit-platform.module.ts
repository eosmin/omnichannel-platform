import { Global, Module } from '@nestjs/common'

import { MAGIC_LINK_EMAIL_LIMIT, MagicLinkThrottle } from '@platform/core/auth'
import { env } from '@platform/core/config/env'

// Provides `MAGIC_LINK_EMAIL_LIMIT`: the number of magic links one address may ask for in a minute. The limit of the
// code (`MagicLinkThrottle`) unless the test environment raised it for the browser suite (`E2E_MAGIC_LINK_LIMIT`, which
// the env schema refuses in any other environment), read from the validated env once so the service does not.
@Global()
@Module({
  providers: [
    {
      provide: MAGIC_LINK_EMAIL_LIMIT,
      useFactory: (): number => env.E2E_MAGIC_LINK_LIMIT ?? MagicLinkThrottle.limit
    }
  ],
  exports: [MAGIC_LINK_EMAIL_LIMIT]
})
export class MagicLinkLimitPlatformModule {}
