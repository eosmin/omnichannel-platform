import { Global, Module } from '@nestjs/common'

import { AppRoles } from '@platform/core/config'
import { env } from '@platform/core/config/env'
import { RLS_CONTEXT_ENABLED } from '@platform/core/database'

// Provides the switch of Row-Level Security for the requests of the api (`RLS_CONTEXT`), read from the validated env once, so that
// the interceptor that opens the tenant transaction does not read the environment itself. Off, a request behaves as before.

// One definition of "RLS context on" for the interceptor and for the guard of PrismaService: the switch, in the api only (the worker
// gets its contexts in phase 5 of the RLS step)
export function isRlsContextOn(): boolean {
  return env.RLS_CONTEXT && env.APP_ROLE === AppRoles.API
}

// The guard of PrismaService (`requireContext`): the switch of the api when the process is the api, and the one of the worker when it is
// the worker, each with its own flag, so that the worker can adopt its contexts without the api changing
export function isRequireContextOn(): boolean {
  return env.APP_ROLE === AppRoles.API ? env.RLS_CONTEXT : env.WORKER_RLS_CONTEXT
}

@Global()
@Module({
  providers: [{ provide: RLS_CONTEXT_ENABLED, useFactory: isRlsContextOn }],
  exports: [RLS_CONTEXT_ENABLED]
})
export class RlsContextPlatformModule {}
