import { PluginInstallationStatus, PluginStatus } from './status-enums'

// What a row of the plugin catalog is (D19). An integration plugin calls the plugin API and has no
// class in the code; a channel is the one the registry holds.
export const PluginCatalogTypes = {
  CHANNEL: 'channel',
  // The carriers of the shipping engine, one catalog entry for all of them (TDD_17 §1)
  CARRIER: 'carrier',
  INTEGRATION: 'integration'
} as const
export type PluginCatalogType = (typeof PluginCatalogTypes)[keyof typeof PluginCatalogTypes]

// The marketplace, plan-gated and paid plugins are Phase 2; every plugin of the MVP is free.
export const PluginPricingModels = { FREE: 'free' } as const

// The bounds of a manifest that the owner pastes (TDD_10 §6.1). Every list and text has a ceiling, so a document that
// is stored as it is cannot grow without limit.
export const PluginManifestLimits = {
  NAME_MAX_LENGTH: 100,
  DESCRIPTION_MAX_LENGTH: 500,
  VERSION_MAX_LENGTH: 32,
  EMAIL_MAX_LENGTH: 254,
  URL_MAX_LENGTH: 2048,
  HEADER_MAX_LENGTH: 64,
  MAX_WEBHOOK_EVENTS: 200,
  MAX_WIDGETS: 10,
  WIDGET_ID_MAX_LENGTH: 64,
  MIN_WIDGET_SIZE: 100,
  MAX_WIDGET_SIZE: 2000,
  MIN_WIDGET_REFRESH_MS: 1000,
  MAX_WIDGET_REFRESH_MS: 3_600_000,
  MIN_REQUESTS_PER_MINUTE: 1,
  MAX_REQUESTS_PER_MINUTE: 600,
  MIN_WEBHOOKS_PER_DAY: 1,
  MAX_WEBHOOKS_PER_DAY: 1_000_000
} as const

// How many private plugins an organization may register: the catalog of its stores stays one screen long and a
// loop that registers cannot fill the table
export const PluginRegistrationLimits = { MAX_PER_ORGANIZATION: 50 } as const

// Who the catalog names as the author of the plugins that ship with the platform
export const OfficialPluginAuthor = {
  NAME: 'Omnichannel Platform',
  EMAIL: 'plugins@omnichannel.invalid'
} as const

// Who the catalog names as the author of a plugin that the code registers and that is not official (the toy channel
// of the suites): its own name, and an address that is nobody's
export const CodePluginAuthor = {
  EMAIL: 'plugins@code.invalid',
  NAME_MAX_LENGTH: 100
} as const

// The key a plugin calls the plugin API with starts with this, so that a leaked one is found by a secret scanner and cannot
// be taken for the key of a store (`pk_live_`, ApiKeyGuard): each guard refuses the other's tokens at the prefix
export const PLUGIN_API_KEY_TOKEN_PREFIX = 'plg_live_'

// The install flow of an integration plugin (TDD_10 §6.3) and the keys it makes
export const PluginInstallLimits = {
  // The one-time code the plugin exchanges for its key: 256 bits, five minutes, used once
  SETUP_CODE_BYTES: 32,
  SETUP_CODE_TTL_SECONDS: 300,
  // The secret of the key itself (the hash alone is enough to keep, as for the keys of a store)
  KEY_SECRET_BYTES: 32,
  // The only part of the key that is shown again
  KEY_DISPLAY_PREFIX_LENGTH: 12,
  // What the platform sends to the webhook endpoint at install, and how much of the answer it reads
  CHALLENGE_BYTES: 32,
  CHALLENGE_TIMEOUT_MS: 5000,
  CHALLENGE_MAX_RESPONSE_BYTES: 1024,
  // Used when the manifest names no limit of its own
  DEFAULT_REQUESTS_PER_MINUTE: 60
} as const

// What the platform posts to `webhooks.endpoint` before it trusts the address, and what the plugin must answer: a 200 with
// the same `challenge` in a JSON body proves that whoever holds the address wants this install
export const PluginChallenge = {
  TYPE: 'plugin.challenge',
  FIELD: 'challenge'
} as const

// The rate window of a plugin key, counted per installation
export const PluginApiRateLimit = {
  WINDOW_MS: 60_000,
  THROTTLER_NAME: 'plugin-api'
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
