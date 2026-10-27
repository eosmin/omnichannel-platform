import { Module } from '@nestjs/common'

import { PluginsModule } from '@platform/plugins/runtime'

import { RegisteredChannels } from './registered-channels.service'

// The plugin registries of the api, and the check that a channel taken from a request exists. The
// official plugins are registered by PluginsModule when their libraries exist (Steps 2.7 and 2.8).
@Module({
  imports: [PluginsModule.forRoot()],
  providers: [RegisteredChannels],
  exports: [PluginsModule, RegisteredChannels]
})
export class ChannelRegistryModule {}
