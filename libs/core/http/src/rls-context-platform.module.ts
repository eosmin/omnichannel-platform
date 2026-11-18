import { Global, Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { RLS_CONTEXT_ENABLED } from '@platform/core/database'

// Provides the switch of Row-Level Security for the requests of the api (`RLS_CONTEXT`), read from the validated env once, so that
// the interceptor that opens the tenant transaction does not read the environment itself. Off, a request behaves as before.

@Global()
@Module({
  providers: [{ provide: RLS_CONTEXT_ENABLED, useFactory: (): boolean => env.RLS_CONTEXT }],
  exports: [RLS_CONTEXT_ENABLED]
})
export class RlsContextPlatformModule {}
