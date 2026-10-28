import { PluginInstallationStatus, PluginStatus } from './status-enums'

// What a row of the plugin catalog is (D19). An integration plugin calls the plugin API and has no
// class in the code; a channel is the one the registry holds.
export const PluginCatalogTypes = {
  CHANNEL: 'channel',
  INTEGRATION: 'integration'
} as const
export type PluginCatalogType = (typeof PluginCatalogTypes)[keyof typeof PluginCatalogTypes]

// The marketplace, plan-gated and paid plugins are Phase 2; every plugin of the MVP is free.
export const PluginPricingModels = { FREE: 'free' } as const

// Who the catalog names as the author of the plugins that ship with the platform
export const OfficialPluginAuthor = {
  NAME: 'Omnichannel Platform',
  EMAIL: 'plugins@omnichannel.invalid'
} as const

// A channel connection works only while the installation it hangs from is active and its plugin
// is approved (D19). Every path that receives, sends or checks through a connection adds
// OfActiveInstallation to its query, so a connection that outlives an uninstall that failed half
// way, or a plugin the owner suspended, is inert. `isInstallationActive` is the same rule for a row
// that was read with its installation.
export const OfActiveInstallation = {
  installation: {
    status: PluginInstallationStatus.ACTIVE,
    plugin: { status: PluginStatus.APPROVED }
  }
} as const

export function isInstallationActive(installation: {
  status: string
  plugin: { status: string }
}): boolean {
  return (
    installation.status === String(PluginInstallationStatus.ACTIVE) &&
    installation.plugin.status === String(PluginStatus.APPROVED)
  )
}
