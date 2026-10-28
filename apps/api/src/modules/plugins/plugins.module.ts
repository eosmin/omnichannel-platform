import { Module } from '@nestjs/common'

import { ChannelRegistryModule } from '../channel-registry'
import { ChannelsModule } from '../channels/channels.module'
import { TenancyModule } from '../tenancy'

import { PluginCatalogSync } from './plugin-catalog-sync.service'
import { PluginInstallationsService } from './plugin-installations.service'
import { PluginsController } from './plugins.controller'

// The catalog of plugins and the installation of each in a store (D19). The sync writes the
// official ones at boot; uninstalling a channel disconnects its connections through the channels
// module.
@Module({
  imports: [ChannelRegistryModule, ChannelsModule, TenancyModule],
  controllers: [PluginsController],
  providers: [PluginCatalogSync, PluginInstallationsService]
})
export class PluginsApiModule {}
