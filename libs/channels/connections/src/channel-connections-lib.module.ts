import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'

import { ChannelContextFactory } from './channel-context.factory'
import { ChannelHealthService } from './channel-health.service'
import { ChannelOAuthConfig } from './channel-oauth-config'
import { ChannelTokenExpiryService } from './channel-token-expiry.service'

// What every process that talks to a channel needs: the context of a connection (its credentials,
// decrypted for one call) and its health. The database, the event bus and the logger come from the
// platform module of the app.
@Module({
  imports: [CryptoPlatformModule],
  providers: [
    ChannelContextFactory,
    ChannelHealthService,
    ChannelTokenExpiryService,
    {
      provide: ChannelOAuthConfig,
      // The env is imported when the provider is built and not at the top of the file: a unit spec that
      // loads the barrel has no DATABASE_URL to parse (as MetaPlatformModule does)
      useFactory: async (): Promise<ChannelOAuthConfig> => {
        const { env, envSource } = await import('@platform/core/config/env')
        // The address of the login is a variable of the provider's block (`META_OAUTH_REDIRECT_URI`, checked by the
        // plugin's schema): this lib is a channel lib and may read the one shared lib of its provider
        const { META_ENV_KEYS, parseMetaEnv } = await import('@platform/channels/meta')
        return {
          redirectUri: parseMetaEnv(envSource(META_ENV_KEYS)).META_OAUTH_REDIRECT_URI,
          frontendUrl: env.FRONTEND_URL
        }
      }
    }
  ],
  exports: [
    ChannelContextFactory,
    ChannelHealthService,
    ChannelTokenExpiryService,
    ChannelOAuthConfig,
    CryptoPlatformModule
  ]
})
export class ChannelConnectionsLibModule {}
