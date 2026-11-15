import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { PluginsModule } from '@platform/plugins/runtime'

import { RemoteChannelHealthService } from './remote-channel-health.service'
import { RemoteChannelSync } from './remote-channel-sync.service'

// What a process that runs remote channel plugins needs (TDD_10 §6.7): their adapters in the registry, kept in step with the
// database, and their health round. It lives apart from `channels-connections` because the registry belongs to the plugins runtime,
// which already reaches that library (the callback address of the channels of the official composition).
@Module({
  imports: [ChannelConnectionsLibModule, PluginsModule.forRoot()],
  providers: [RemoteChannelSync, RemoteChannelHealthService],
  exports: [RemoteChannelSync, RemoteChannelHealthService]
})
export class RemoteChannelsLibModule {}
