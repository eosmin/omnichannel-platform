import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CHANNEL_IDENTITY_KINDS,
  type ChannelIdentityKindSource,
  ChannelIdentityKinds
} from '@platform/core/domain'
import type { CarrierPlugin, ChannelPlugin } from '@platform/plugins/sdk'

import { CarrierRegistry } from './carrier-registry'
import {
  OFFICIAL_CARRIER_PLUGINS,
  OFFICIAL_CHANNEL_PLUGINS,
  OFFICIAL_PLUGIN_IMPORTS
} from './official-plugins'
import { PluginRegistry } from './plugin-registry'

export interface PluginsModuleOptions {
  channels: readonly Type<ChannelPlugin>[]
  carriers: readonly Type<CarrierPlugin>[]
  // Modules that provide what the plugins inject
  imports?: readonly Type<unknown>[]
}

const OFFICIAL: PluginsModuleOptions = {
  channels: OFFICIAL_CHANNEL_PLUGINS,
  carriers: OFFICIAL_CARRIER_PLUGINS,
  imports: OFFICIAL_PLUGIN_IMPORTS
}

// Plugins are Nest providers, so they can receive what they need. Both apps import it: the worker
// sends the outbound messages and fetches the media. A test passes the plugins of its suite.
//
// The registries are filled by the factory that builds them and not by an onModuleInit hook: Nest
// gives no order between the hooks of sibling modules, and a module that reads the registry in its
// own hook must never see it empty. A plugin that breaks its contract fails the boot.
@Module({})
export class PluginsModule {
  static forRoot(options: PluginsModuleOptions = OFFICIAL): DynamicModule {
    const withToy = options === OFFICIAL
    const channelRegistry: Provider = {
      provide: PluginRegistry,
      useFactory: async (
        logger: PinoLogger,
        ...plugins: ChannelPlugin[]
      ): Promise<PluginRegistry> => {
        const registry = new PluginRegistry(logger)
        // Only an instance of the exact class of an official list owns the official ids. The prototype
        // is read, not `constructor`, which an object can set to anything
        for (const plugin of plugins) {
          const official = OFFICIAL_CHANNEL_PLUGINS.some(
            cls => Object.getPrototypeOf(plugin) === cls.prototype
          )
          registry.register(plugin, { official, fromCode: true })
        }
        // The toy channel of the suites, only in the composition of the apps and only when the environment turns it
        // on (which a test environment alone accepts). Loaded when asked, so nothing of it runs otherwise.
        if (withToy) {
          const toy = await import('@platform/channels/toy')
          if (await toy.isToyChannelEnabled()) {
            registry.register(new toy.ToyChannelPlugin(), { official: false, fromCode: true })
          }
        }
        return registry
      },
      inject: [PinoLogger, ...options.channels]
    }
    const carrierRegistry: Provider = {
      provide: CarrierRegistry,
      useFactory: (logger: PinoLogger, ...plugins: CarrierPlugin[]): CarrierRegistry => {
        const registry = new CarrierRegistry(logger)
        for (const plugin of plugins) registry.register(plugin)
        return registry
      },
      inject: [PinoLogger, ...options.carriers]
    }
    const identityKinds: Provider = {
      provide: CHANNEL_IDENTITY_KINDS,
      useFactory: (registry: PluginRegistry): ChannelIdentityKindSource => ({
        kindOf: channelType => registry.identityKindOf(channelType) ?? ChannelIdentityKinds.OPAQUE
      }),
      inject: [PluginRegistry]
    }
    return {
      module: PluginsModule,
      imports: [...(options.imports ?? [])],
      providers: [
        channelRegistry,
        carrierRegistry,
        identityKinds,
        ...options.channels,
        ...options.carriers
      ],
      exports: [PluginRegistry, CarrierRegistry, CHANNEL_IDENTITY_KINDS]
    }
  }
}
