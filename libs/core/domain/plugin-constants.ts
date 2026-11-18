import { ChannelCapability } from './channel-capability'
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
  MIN_REQUESTS_PER_MINUTE: 1,
  MAX_REQUESTS_PER_MINUTE: 600,
  MIN_WEBHOOKS_PER_DAY: 1,
  MAX_WEBHOOKS_PER_DAY: 1_000_000,
  // The text of a connection field of a channel plugin, in each language (TDD_10 §6.7.2)
  FIELD_LABEL_MAX_LENGTH: 60
} as const

// The `channel` block of the manifest of a channel plugin (TDD_10 §6.7.2)
export const ChannelManifestLimits = {
  LABEL_MAX_LENGTH: 40,
  MIN_WINDOW_HOURS: 1,
  MAX_WINDOW_HOURS: 720
} as const

// What a manifest may declare a channel can do. The rest of `ChannelCapability` (templates, buttons, location,
// reactions, ...) needs a command the platform does not send to a remote plugin, so the validator refuses it
// (TDD_10 §6.7.2). `caption_per_file`: the plugin carries the text of each file in the command that sends it.
export const ManifestChannelCapabilities: readonly string[] = [
  ChannelCapability.TEXT,
  ChannelCapability.IMAGE,
  ChannelCapability.VIDEO,
  ChannelCapability.AUDIO,
  ChannelCapability.DOCUMENT,
  ChannelCapability.REPLY_TO,
  ChannelCapability.DELIVERY_RECEIPTS,
  ChannelCapability.READ_RECEIPTS,
  ChannelCapability.TYPING_INDICATOR,
  ChannelCapability.CUSTOMER_TYPING,
  ChannelCapability.CAPTION_PER_FILE
]

// The scopes a channel plugin must hold (TDD_10 §6.2, §6.7.2): the routes that use them arrive with Step 5.6 PR C3
export const ChannelPluginScopes = {
  CONNECTIONS: 'channel:connections',
  EVENTS: 'channel:events'
} as const

// The icon of a plugin is fetched once, when it is registered, and the platform keeps only its own 128 by 128 PNG
// (TDD_10 §6.7.2). The original is never served.
export const PluginIconLimits = {
  MAX_BYTES: 64 * 1024,
  SIZE_PX: 128,
  FETCH_TIMEOUT_MS: 10_000,
  // A picture with more pixels than this is not decoded: a few KB of PNG can hold gigapixels
  MAX_INPUT_PIXELS: 4_000_000,
  KEY_PREFIX: 'plugin-icons/',
  CONTENT_TYPE: 'image/png'
} as const

// Where the platform keeps the picture of a plugin; platform level, not under a store
export const pluginIconKey = (pluginId: string): string =>
  `${PluginIconLimits.KEY_PREFIX}${pluginId}.png`

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

// What the audit log and the notifications name an installation of a plugin
export const PLUGIN_INSTALLATION_RESOURCE_TYPE = 'plugin_installation'

// What a plugin did to a message, as the audit entry `message.plugin_changed` names it (`metadata.operation`)
export const PluginMessageOperations = {
  EDIT: 'edit',
  DELETE: 'delete',
  RESEND: 'resend',
  DISCARD: 'discard',
  REACT: 'react',
  UNREACT: 'unreact',
  RESEND_CAPTION: 'resend_caption',
  REFETCH_FILE: 'refetch_file'
} as const

// The part of the id of an outbound reaction job that names a plugin instead of a person (a `:` is not allowed in a job id)
export const PLUGIN_REACTION_JOB_ID_PREFIX = 'plugin-'

// The key a plugin calls the plugin API with starts with this, so that a leaked one is found by a secret scanner and cannot
// be taken for the key of a store (`pk_live_`, ApiKeyGuard): each guard refuses the other's tokens at the prefix
export const PLUGIN_API_KEY_TOKEN_PREFIX = 'plg_live_'

// The services of the inbox answer for "a person" (who may see what, who read it last, who did it). A plugin has no user, so the
// call is made as `plugin:<installation id>`: it is never the id of a person, so it matches no assignment and no row of `users`.
// Only what has no foreign key and no uuid contract holds it (`lastReadBy`, the actor of an event); what points at a user or is
// read back as a uuid (the audit log, the exports, the author of a message, the people of a system line) is written some other
// way for a plugin: the audit log as the system with the installation in its metadata, a system line as the system.
export const PLUGIN_ACTOR_PREFIX = 'plugin:'

// The id of a plugin as the owner of what it asked for (an export, an upload): the prefix and the uuid of its installation
export const PLUGIN_ACTOR_ID_PATTERN =
  /^plugin:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

// What the owner types to revoke an integration plugin (TDD_10 §6.6): the word, as written, so that a click cannot revoke
export const PLUGIN_REVOKE_CONFIRMATION = 'REVOKE'

// The word has a ceiling so that a body is never more than that
export const PluginRevokeLimits = { CONFIRMATION_MAX_LENGTH: 32 } as const

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

// Why the guard of the plugin API refused a call (the audit entry `plugin.api_denied` carries it), and how many entries it may write:
// a plugin that probes the routes outside its scopes must not fill the audit log. One entry per installation and reason in each
// window; a key nobody knows has no installation, so those get one entry per address and a budget for the whole window.
export const PluginApiDenialReasons = {
  INVALID_KEY: 'invalid_key',
  INACTIVE: 'inactive',
  SCOPE: 'scope',
  PERMISSION: 'permission',
  // A route that names no scopes or no permission: a mistake of the code, kept apart so that it cannot mask a real refusal
  ROUTE_UNDECLARED: 'route_undeclared'
} as const
export type PluginApiDenialReason =
  (typeof PluginApiDenialReasons)[keyof typeof PluginApiDenialReasons]

export const PluginApiDenialAudit = {
  WINDOW_SECONDS: 300,
  // One entry per address in a window, and no more than this many in all for the keys no installation owns
  ANONYMOUS_PER_WINDOW: 60
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
