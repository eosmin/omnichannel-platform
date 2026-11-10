import { Global, Module } from '@nestjs/common'

import { MagicLinkThrottle } from '@platform/core/auth'
import { env } from '@platform/core/config/env'

// The number of magic links one address may ask for in a minute. The limit of the code (`MagicLinkThrottle`)
// unless the test environment raised it for the browser suite (`E2E_MAGIC_LINK_LIMIT`, which the env schema
// refuses in any other environment), read from the validated env once so that the service does not read it itself.
export const MAGIC_LINK_EMAIL_LIMIT = Symbol('MAGIC_LINK_EMAIL_LIMIT')

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
