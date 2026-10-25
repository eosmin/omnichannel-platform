import { type DynamicModule, Global, Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'

import { AUTH_SETTINGS, type AuthSettings } from './auth-settings'
import { AuthGuard } from './auth.guard'
import { JwtStrategy } from './jwt.strategy'

// Signing and verifying access tokens, and the global guard that demands one. Global because every
// module of the api is behind the guard and the session code needs JwtService and the settings.
@Global()
@Module({})
export class AccessTokenModule {
  static forRoot(settings: AuthSettings): DynamicModule {
    return {
      module: AccessTokenModule,
      imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
          secret: settings.jwtSecret,
          signOptions: { algorithm: 'HS256', expiresIn: settings.accessTtlSeconds },
          // Whoever verifies with JwtService, not only the strategy, accepts HS256 and nothing else
          verifyOptions: { algorithms: ['HS256'] }
        })
      ],
      providers: [
        { provide: AUTH_SETTINGS, useValue: settings },
        JwtStrategy,
        { provide: APP_GUARD, useClass: AuthGuard }
      ],
      exports: [JwtModule, AUTH_SETTINGS]
    }
  }
}
