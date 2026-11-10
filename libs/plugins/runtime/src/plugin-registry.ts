import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  CHANNEL_ID_PATTERN,
  type ChannelIdentityKind,
  type ChannelOAuthDescriptor,
  type ChannelLimitsView,
  isOfficialChannelId
} from '@platform/core/domain'
import {
  ChannelCapability,
  type ChannelCapabilityType,
  type ChannelPlugin,
  PluginTypes
} from '@platform/plugins/sdk'

import { type ConnectManifest, snapshotConnectManifest } from './connect-manifest'
import {
  assertMethodsForCapabilities,
  contractViolation,
  pluginAlreadyRegistered,
  pluginNotFound,
  printable,
  snapshotCapabilities
} from './contract-rules'
import { type ChannelDescriptorSnapshot, snapshotChannelDescriptor } from './descriptor-snapshot'
import { snapshotChannelLimits, snapshotIdentityKind } from './limits-snapshot'
import { type ChannelMediaSnapshot, snapshotChannelMedia } from './media-snapshot'
import { type ChannelOAuthSnapshot, snapshotChannelOAuth } from './oauth-snapshot'

const METHODS_BY_CAPABILITY = [
  [ChannelCapability.TEMPLATES, 'sendTemplate'],
  [ChannelCapability.TEMPLATES, 'listTemplates'],
  [ChannelCapability.BUTTONS, 'sendButtons'],
  [ChannelCapability.LOCATION, 'sendLocation'],
  [ChannelCapability.TYPING_INDICATOR, 'sendTypingIndicator'],
  [ChannelCapability.READ_RECEIPTS, 'markAsRead'],
  [ChannelCapability.REACTIONS, 'sendReaction'],
  [ChannelCapability.DELETE_MESSAGE, 'deleteMessage'],
  [ChannelCapability.EDIT_MESSAGE, 'editMessage'],
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
  // Registered by the composition of the process (the code of the platform), official or not: the catalog
  // writes a row for it at boot so that a store can install it. A remote plugin is not, it comes with its own row.
  fromCode?: boolean
  // A private plugin: only these stores see it in `list`. Without it the plugin is visible to all.
  storeIds?: readonly string[]
}

interface Entry {
  plugin: ChannelPlugin
  // A copy taken when the plugin passed its contract: what it declares later does not count
  capabilities: ReadonlySet<ChannelCapabilityType>
  manifest: ConnectManifest
  // The provider's login, checked and copied at registration; null when the plugin has none
  oauth: ChannelOAuthSnapshot | null
  // The files the plugin takes, checked and copied at registration; null when it declares no kind of file
  media: ChannelMediaSnapshot | null
  // What the plugin declared for the text of a message and for the handle of a customer, checked and copied
  limits: ChannelLimitsView
  descriptor: ChannelDescriptorSnapshot
  identityKind: ChannelIdentityKind
  fromCode: boolean
  // One of the plugins that ship with the platform (the ceiling of a third party's login is read from these)
  official: boolean
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
    this.entries.set(id, {
      plugin,
      capabilities: new Set(capabilities),
      manifest: snapshotConnectManifest(plugin, id, capabilities),
      oauth: snapshotChannelOAuth(
        plugin,
        id,
        this.oauthCeilingFor(plugin, options.official === true)
      ),
      media: snapshotChannelMedia(plugin, id, capabilities),
      limits: snapshotChannelLimits(plugin, id),
      descriptor: snapshotChannelDescriptor(plugin, id, options.official === true),
      identityKind: snapshotIdentityKind(plugin, id),
      fromCode: options.fromCode === true || options.official === true,
      official: options.official === true,
      storeIds
    })
    this.logger.info({ pluginId: id, version: plugin.version }, 'plugin registered')
  }

  // What the login of a plugin may ask for (see `snapshotChannelOAuth`): nothing limits an official plugin; any
  // other is held to the permissions that the official plugins with the same kind of login ask for. Read from the
  // plugin once, here, so that the kind checked is the kind of the login that is kept.
  private oauthCeilingFor(plugin: ChannelPlugin, official: boolean): ReadonlySet<string> | null {
    if (official) return null
    const declared: unknown = plugin.oauth
    const kind: unknown =
      typeof declared === 'object' && declared !== null
        ? (declared as { kind?: unknown }).kind
        : undefined
    const ceiling = new Set<string>()
    for (const entry of this.entries.values()) {
      if (!entry.official || entry.oauth === null || entry.oauth.kind !== kind) continue
      for (const scope of entry.oauth.scopes) ceiling.add(scope)
    }
    return ceiling
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

  // The plugins the composition of this process registered, official or not: what the catalog writes at boot
  listFromCode(): ChannelPlugin[] {
    return [...this.entries.values()].filter(entry => entry.fromCode).map(entry => entry.plugin)
  }

  // What the plugin declared when it was registered: the web app draws only the actions a channel can
  // do. A plugin that is not registered declares nothing.
  capabilitiesOf(pluginId: string): ChannelCapabilityType[] {
    return [...(this.entries.get(pluginId)?.capabilities ?? [])]
  }

  // What the plugin declared for the settings page when it registered: the form it asks for, whether
  // the provider calls the api, and the owner step for the profile. Null for a plugin not registered.
  connectManifestOf(pluginId: string): ConnectManifest | null {
    return this.entries.get(pluginId)?.manifest ?? null
  }

  // The files the plugin takes as it declared them when it registered (types and largest size by kind, files
  // per message), or null when it takes none or is not registered
  mediaOf(pluginId: string): ChannelMediaSnapshot | null {
    return this.entries.get(pluginId)?.media ?? null
  }

  // The login of the plugin as it was when it registered (Step 7.8), or null when it has none or is not
  // registered. The scopes are never sent to the browser: only the core builds the address of the dialog.
  oauthOf(pluginId: string): ChannelOAuthSnapshot | null {
    return this.entries.get(pluginId)?.oauth ?? null
  }

  // The text limits the plugin declared when it registered, or null when it is not registered
  limitsOf(pluginId: string): ChannelLimitsView | null {
    return this.entries.get(pluginId)?.limits ?? null
  }

  // How the plugin said it is named and drawn, and where its pictures come from, as it declared it when it
  // registered (frozen), or null when it is not registered
  descriptorOf(pluginId: string): ChannelDescriptorSnapshot | null {
    return this.entries.get(pluginId)?.descriptor ?? null
  }

  // How the plugin said the handle of a customer is read, or null when it is not registered
  identityKindOf(pluginId: string): ChannelIdentityKind | null {
    return this.entries.get(pluginId)?.identityKind ?? null
  }

  // How the login of the plugin is drawn, as it declared it when it registered (frozen), or null when it has
  // none or is not registered
  oauthDescriptorOf(pluginId: string): ChannelOAuthDescriptor | null {
    return this.entries.get(pluginId)?.oauth?.descriptor ?? null
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
