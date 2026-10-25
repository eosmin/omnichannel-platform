import { Module } from '@nestjs/common'

import { AccessTokenModule } from '@platform/core/auth-module'
import { env } from '@platform/core/config/env'

// The access tokens and the global guard that demands them, configured from the validated env
@Module({
  imports: [
    AccessTokenModule.forRoot({
      jwtSecret: env.JWT_SECRET,
      accessTtlSeconds: env.JWT_EXPIRES_IN,
      refreshTtlSeconds: env.REFRESH_TOKEN_EXPIRES_IN,
      frontendUrl: env.FRONTEND_URL
    })
  ]
})
export class AuthPlatformModule {}
