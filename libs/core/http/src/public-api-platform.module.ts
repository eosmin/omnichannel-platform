import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

// Where the api answers on the internet: the base of the urls an owner pastes into a provider's
// dashboard (the callback url of a channel). Read from the validated env here, so that a service
// receives it and never reads the environment itself.
export abstract class PublicApiConfig {
  abstract readonly apiUrl: string
}

@Module({
  providers: [{ provide: PublicApiConfig, useValue: { apiUrl: env.API_URL } }],
  exports: [PublicApiConfig]
})
export class PublicApiPlatformModule {}
