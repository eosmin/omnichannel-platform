import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'

import { ChannelContextFactory } from './channel-context.factory'
import { ChannelHealthService } from './channel-health.service'

// What every process that talks to a channel needs: the context of a connection (its credentials,
// decrypted for one call) and its health. The database, the event bus and the logger come from the
// platform module of the app.
@Module({
  imports: [CryptoPlatformModule],
  providers: [ChannelContextFactory, ChannelHealthService],
  exports: [ChannelContextFactory, ChannelHealthService, CryptoPlatformModule]
})
export class ChannelConnectionsLibModule {}
