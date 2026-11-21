import { Global, Module } from '@nestjs/common'

import { AUTHENTICATED_USER_RATE_LIMIT, authenticatedUserRateLimitOf } from '@platform/core/auth'
import { env } from '@platform/core/config/env'

// Provides `AUTHENTICATED_USER_RATE_LIMIT`: the general budget of a person. The profile of the code unless the test environment
// raised it for the browser suite (`E2E_USER_RATE_LIMIT`, which the env schema refuses in any other environment), read from the
// validated env once so the guard does not (the guard itself reads nothing: unit specs must not parse the env).
@Global()
@Module({
  providers: [
    {
      provide: AUTHENTICATED_USER_RATE_LIMIT,
      useFactory: () => authenticatedUserRateLimitOf(env.E2E_USER_RATE_LIMIT)
    }
  ],
  exports: [AUTHENTICATED_USER_RATE_LIMIT]
})
export class AuthenticatedUserRateLimitPlatformModule {}
