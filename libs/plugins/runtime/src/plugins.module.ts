import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CHANNEL_ANONYMITY,
  CHANNEL_IDENTITY_KINDS,
  type ChannelAnonymitySource,
  type ChannelIdentityKindSource,
  ChannelIdentityKinds
} from '@platform/core/domain'
import type { CarrierPlugin, ChannelPlugin } from '@platform/plugins/sdk'

import { CarrierRegistry } from './carrier-registry'
import {
  type CarrierPluginSource,
  OFFICIAL_CARRIER_PLUGINS,
  OFFICIAL_CHANNEL_PLUGINS,
  OFFICIAL_PLUGIN_IMPORTS
} from './official-plugins'
import { PluginRegistry } from './plugin-registry'

export interface PluginsModuleOptions {
  channels: readonly Type<ChannelPlugin>[]
  carriers: readonly CarrierPluginSource[]
  // Modules that provide what the plugins inject
  imports?: readonly Type<unknown>[]
}

// A class is provided as itself; a plugin that is an object is provided as a value under a token of its own
function carrierProviderOf(source: CarrierPluginSource): {
  token: Type<CarrierPlugin> | symbol
  provider: Provider
} {
  if (typeof source === 'function') return { token: source, provider: source }
  const token = Symbol(`carrier:${source.id}`)
  return { token, provider: { provide: token, useValue: source } }
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
        const registry = new PluginRegistry(
          logger,
          await (await import('@platform/channels/oauth-callback')).oauthCallbackUrl()
        )
        // Only an instance of the exact class of an official list owns the official ids. The prototype
        // is read, not `constructor`, which an object can set to anything
        const isOfficial = (plugin: ChannelPlugin): boolean =>
          OFFICIAL_CHANNEL_PLUGINS.some(cls => Object.getPrototypeOf(plugin) === cls.prototype)
        // The official ones first, whatever the order of the list: the login of any other plugin is held to what
        // the official ones ask for, so they must be registered before it
        const ordered = [...plugins.filter(isOfficial), ...plugins.filter(p => !isOfficial(p))]
        for (const plugin of ordered) {
          const official = isOfficial(plugin)
          registry.register(plugin, { official, fromCode: official })
        }
        // The toy channel of the suites, only in the composition of the apps and only when the environment turns it
        // on (which a test environment alone accepts).
        if (withToy) {
          // The switch first, from a module that holds only the variable: the plugin itself is not loaded, and so
          // not evaluated, unless the environment (a test one) turned it on
          const { isToyChannelEnabled } = await import('@platform/channels/toy-env')
          if (await isToyChannelEnabled()) {
            const { ToyChannelPlugin } = await import('@platform/channels/toy')
            registry.register(new ToyChannelPlugin(), { official: false, fromCode: true })
          }
        }
        return registry
      },
      inject: [PinoLogger, ...options.channels]
    }
    const carrierProviders = options.carriers.map(carrierProviderOf)
    const carrierRegistry: Provider = {
      provide: CarrierRegistry,
      useFactory: (logger: PinoLogger, ...plugins: CarrierPlugin[]): CarrierRegistry => {
        const registry = new CarrierRegistry(logger)
        for (const plugin of plugins) registry.register(plugin)
        return registry
      },
      inject: [PinoLogger, ...carrierProviders.map(entry => entry.token)]
    }
    const identityKinds: Provider = {
      provide: CHANNEL_IDENTITY_KINDS,
      useFactory: (registry: PluginRegistry): ChannelIdentityKindSource => ({
        kindOf: channelType => registry.identityKindOf(channelType) ?? ChannelIdentityKinds.OPAQUE
      }),
      inject: [PluginRegistry]
    }
    const anonymity: Provider = {
      provide: CHANNEL_ANONYMITY,
      useFactory: (registry: PluginRegistry): ChannelAnonymitySource => ({
        anonymousOf: channelType => registry.descriptorOf(channelType)?.anonymousCustomers ?? false
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
        anonymity,
        ...options.channels,
        ...carrierProviders.map(entry => entry.provider)
      ],
      exports: [PluginRegistry, CarrierRegistry, CHANNEL_IDENTITY_KINDS, CHANNEL_ANONYMITY]
    }
  }
}
