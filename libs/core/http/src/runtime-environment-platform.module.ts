import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

export const RUNTIME_ENVIRONMENT = Symbol('RUNTIME_ENVIRONMENT')

// The environment the process runs in (development, test, staging, production), from the validated env. A library outside libs/core may
// not read the env, so it asks for this token: the fiscal runtime decides from it whether a provider that signs nothing real may exist.
@Module({
  providers: [{ provide: RUNTIME_ENVIRONMENT, useValue: env.NODE_ENV }],
  exports: [RUNTIME_ENVIRONMENT]
})
export class RuntimeEnvironmentPlatformModule {}
