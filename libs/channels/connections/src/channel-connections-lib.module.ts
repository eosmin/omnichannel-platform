import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'
import { PluginsModule } from '@platform/plugins/runtime'

import { ChannelContextFactory } from './channel-context.factory'
import { ChannelHealthService } from './channel-health.service'
import { ChannelOAuthConfig } from './channel-oauth-config'
import { ChannelTokenExpiryService } from './channel-token-expiry.service'
import { RemoteChannelHealthService } from './remote-channel-health.service'
import { RemoteChannelSync } from './remote-channel-sync.service'

// What every process that talks to a channel needs: the context of a connection (its credentials,
// decrypted for one call) and its health. The database, the event bus and the logger come from the
// platform module of the app.
@Module({
  imports: [CryptoPlatformModule, PluginsModule.forRoot()],
  providers: [
    ChannelContextFactory,
    ChannelHealthService,
    ChannelTokenExpiryService,
    RemoteChannelSync,
    RemoteChannelHealthService,
    {
      provide: ChannelOAuthConfig,
      // The env is imported when the provider is built and not at the top of the file: a unit spec that
      // loads the barrel has no DATABASE_URL to parse (as MetaPlatformModule does)
      useFactory: async (): Promise<ChannelOAuthConfig> => {
        const { env } = await import('@platform/core/config/env')
        return { frontendUrl: env.FRONTEND_URL }
      }
    }
  ],
  exports: [
    ChannelContextFactory,
    ChannelHealthService,
    ChannelTokenExpiryService,
    RemoteChannelSync,
    RemoteChannelHealthService,
    ChannelOAuthConfig,
    CryptoPlatformModule
  ]
})
export class ChannelConnectionsLibModule {}
