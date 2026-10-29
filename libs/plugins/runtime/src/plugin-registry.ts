import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { CHANNEL_ID_PATTERN, isOfficialChannelId } from '@platform/core/domain'
import {
  ChannelCapability,
  type ChannelCapabilityType,
  type ChannelPlugin,
  PluginTypes
} from '@platform/plugins/sdk'

import {
  assertMethodsForCapabilities,
  contractViolation,
  pluginAlreadyRegistered,
  pluginNotFound,
  printable,
  snapshotCapabilities
} from './contract-rules'

const METHODS_BY_CAPABILITY = [
  [ChannelCapability.TEMPLATES, 'sendTemplate'],
  [ChannelCapability.TEMPLATES, 'listTemplates'],
  [ChannelCapability.BUTTONS, 'sendButtons'],
  [ChannelCapability.LOCATION, 'sendLocation'],
  [ChannelCapability.TYPING_INDICATOR, 'sendTypingIndicator'],
  [ChannelCapability.READ_RECEIPTS, 'markAsRead'],
  [ChannelCapability.REACTIONS, 'sendReaction'],
  [ChannelCapability.CUSTOMER_PROFILE, 'fetchProfile']
] as const

// What every channel plugin does, whatever it declares
const REQUIRED_METHODS = [
  'connect',
  'disconnect',
  'healthCheck',
  'sendMessage',
  'sendMedia',
  'validateWebhookSignature',
  'handleWebhook'
] as const

export interface RegisterOptions {
  // Set by the module for the plugins that ship with the platform (and by the suite): the official
  // ids belong to them, so a remote plugin can never take one, whatever the order of registration
  official?: boolean
  // A private plugin: only these stores see it in `list`. Without it the plugin is visible to all.
  storeIds?: readonly string[]
}

interface Entry {
  plugin: ChannelPlugin
  // A copy taken when the plugin passed its contract: what it declares later does not count
  capabilities: ReadonlySet<ChannelCapabilityType>
  storeIds: ReadonlySet<string> | null
}

// The channel plugins of this process, by the id of the plugin: the official ones and, later, the
// remote ones. Both apps build one.
@Injectable()
export class PluginRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly logger: PinoLogger) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(PluginRegistry.name)
  }

  register(plugin: ChannelPlugin, options: RegisterOptions = {}): void {
    // Each field is read once: an accessor cannot answer one thing to the checks and another to the
    // map, and a list the plugin keeps changing cannot grow a capability nobody validated
    const id = plugin.id
    const capabilities = snapshotCapabilities(plugin.capabilities)
    this.validateContract(plugin, id, capabilities)
    // Before the duplicate check, so the answer for an official id does not depend on the order
    if (isOfficialChannelId(id) && !options.official) {
      throw contractViolation(`Plugin id ${printable(id)} is reserved for the official plugin`)
    }
    if (this.entries.has(id)) throw pluginAlreadyRegistered('Plugin', id)
    const storeIds = options.storeIds ? new Set(options.storeIds) : null
    if (storeIds !== null && isOfficialChannelId(id)) {
      throw contractViolation(`Official plugin ${printable(id)} cannot be private to a store`)
    }
    this.entries.set(id, { plugin, capabilities: new Set(capabilities), storeIds })
    this.logger.info({ pluginId: id, version: plugin.version }, 'plugin registered')
  }

  // An official plugin is part of the code and is never removed
  unregister(pluginId: string): void {
    if (isOfficialChannelId(pluginId)) {
      throw contractViolation(`Official plugin ${pluginId} cannot be unregistered`)
    }
    if (!this.entries.delete(pluginId)) throw pluginNotFound('Plugin', pluginId)
    this.logger.info({ pluginId }, 'plugin unregistered')
  }

  // `find`, `get`, `has` and `hasCapability` are lookups of the process, for code that already
  // knows the store (it came from a connection of that store). A route that takes a channel from a
  // request asks `isVisibleTo` (registeredChannelSchema does), and `list` is the catalogue of a store.
  find(pluginId: string): ChannelPlugin | undefined {
    return this.entries.get(pluginId)?.plugin
  }

  has(pluginId: string): boolean {
    return this.entries.has(pluginId)
  }

  // Whether this store may use the plugin: a public one, or a private one registered for it
  isVisibleTo(pluginId: string, storeId: string): boolean {
    const entry = this.entries.get(pluginId)
    return entry !== undefined && (entry.storeIds === null || entry.storeIds.has(storeId))
  }

  get(pluginId: string): ChannelPlugin {
    const plugin = this.find(pluginId)
    if (!plugin) throw pluginNotFound('Plugin', pluginId)
    return plugin
  }

  // The plugins this store may see: the public ones and its own private ones, never another
  // store's
  list(storeId: string): ChannelPlugin[] {
    return [...this.entries.values()]
      .filter(entry => entry.storeIds === null || entry.storeIds.has(storeId))
      .map(entry => entry.plugin)
  }

  // The plugins that ship with the platform: what the catalogue writes at boot
  listOfficial(): ChannelPlugin[] {
    return [...this.entries.values()]
      .filter(entry => isOfficialChannelId(entry.plugin.id))
      .map(entry => entry.plugin)
  }

  // What the plugin declared when it was registered: the web app draws only the actions a channel can
  // do. A plugin that is not registered declares nothing.
  capabilitiesOf(pluginId: string): ChannelCapabilityType[] {
    return [...(this.entries.get(pluginId)?.capabilities ?? [])]
  }

  hasCapability(pluginId: string, capability: ChannelPlugin['capabilities'][number]): boolean {
    return this.entries.get(pluginId)?.capabilities.has(capability) ?? false
  }

  private validateContract(
    plugin: ChannelPlugin,
    id: string,
    capabilities: readonly ChannelCapabilityType[]
  ): void {
    if (plugin.type !== PluginTypes.CHANNEL) {
      throw contractViolation(`Plugin ${printable(id)} is not a channel plugin`)
    }
    if (typeof id !== 'string' || !CHANNEL_ID_PATTERN.test(id)) {
      throw contractViolation(`Plugin id ${printable(id)} does not match ${CHANNEL_ID_PATTERN}`)
    }
    for (const method of REQUIRED_METHODS) {
      if (typeof plugin[method] !== 'function') {
        throw contractViolation(`Plugin ${printable(id)} does not implement ${method}`)
      }
    }
    assertMethodsForCapabilities(id, capabilities, plugin, METHODS_BY_CAPABILITY)
    if (capabilities.includes(ChannelCapability.MESSAGING_WINDOW) && !plugin.messagingWindow) {
      throw contractViolation(`Plugin ${printable(id)} declares messaging_window without a policy`)
    }
  }
}
