import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { PlatformOrigins } from '@platform/core/domain'

@Module({
  providers: [
    {
      provide: PlatformOrigins,
      useValue: {
        origins: [env.FRONTEND_URL, env.API_URL, env.WIDGET_SCRIPT_URL].map(
          url => new URL(url).origin
        )
      }
    }
  ],
  exports: [PlatformOrigins]
})
export class PlatformOriginsPlatformModule {}
