import { Module } from '@nestjs/common'

import { ChannelConnectionsLibModule } from '@platform/channels/connections'
import { RemoteChannelsLibModule } from '@platform/channels/remote'
import {
  CryptoPlatformModule,
  PublicApiPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'

import { CarriersModule } from '../carriers/carriers.module'
import { ChannelRegistryModule } from '../channel-registry'
import { ChannelsModule } from '../channels/channels.module'
import { TenancyModule } from '../tenancy'

import { PluginApiController } from './plugin-api.controller'
import { PluginCatalogSync } from './plugin-catalog-sync.service'
import { PluginChallengeService } from './plugin-challenge.service'
import { PluginCommandSecretService } from './plugin-command-secret.service'
import { PluginIconService } from './plugin-icon.service'
import { PluginInstallationsService } from './plugin-installations.service'
import { PluginIntegrationInstallService } from './plugin-integration-install.service'
import { PluginRegistrationService } from './plugin-registration.service'
import { PluginSetupCodeStore } from './plugin-setup-code.store'
import { PluginSetupExchangeService } from './plugin-setup-exchange.service'
import { PluginsController } from './plugins.controller'

// The catalog of plugins and the installation of each in a store (D19). The sync writes the
// official ones at boot; uninstalling a channel disconnects its connections through the channels
// module.
@Module({
  imports: [
    CarriersModule,
    ChannelConnectionsLibModule,
    ChannelRegistryModule,
    ChannelsModule,
    CryptoPlatformModule,
    PublicApiPlatformModule,
    QueuesPlatformModule,
    RemoteChannelsLibModule,
    TenancyModule
  ],
  controllers: [PluginsController, PluginApiController],
  providers: [
    PluginCatalogSync,
    PluginChallengeService,
    PluginCommandSecretService,
    PluginIconService,
    PluginInstallationsService,
    PluginIntegrationInstallService,
    PluginRegistrationService,
    PluginSetupCodeStore,
    PluginSetupExchangeService
  ]
})
export class PluginsApiModule {}
