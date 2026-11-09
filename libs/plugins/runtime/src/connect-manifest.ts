import {
  ChannelConnectFieldLimits,
  type LocalizedText,
  readLocalizedText,
  RESERVED_CONNECT_FIELD_KEYS
} from '@platform/core/domain'
import { ChannelCapability, type ChannelPlugin } from '@platform/plugins/sdk'

import { contractViolation, printable } from './contract-rules'

// What a channel plugin declared for the settings page, copied and checked once when it registers
// A field as the registry keeps it: the label is a message key or a text of the plugin, never both missing
export interface ConnectFieldSnapshot {
  key: string
  labelKey: string | null
  label: LocalizedText | null
  helpKey: string | null
  secret: boolean
  required: boolean
  multiple: boolean
}

export interface ConnectManifest {
  connectFields: readonly ConnectFieldSnapshot[]
  receivesProviderWebhooks: boolean
  profileSetupKey: string | null
}

function messageKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= ChannelConnectFieldLimits.MESSAGE_KEY_MAX_LENGTH &&
    ChannelConnectFieldLimits.MESSAGE_KEY_PATTERN.test(value)
  )
}

// The page draws a form from this declaration and a third party writes it, so it is held to a shape:
// a field is copied property by property (an accessor or a prototype cannot answer differently
// later), keys are unique, and the label is a message key and never text. A plugin that declares
// nothing valid is refused at boot, like one that lacks a method.
export function snapshotConnectManifest(
  plugin: ChannelPlugin,
  id: string,
  capabilities: readonly string[]
): ConnectManifest {
  const declared: unknown = plugin.connectFields
  if (!Array.isArray(declared) || declared.length > ChannelConnectFieldLimits.MAX_FIELDS) {
    throw contractViolation(`Plugin ${printable(id)} does not declare its connect fields`)
  }
  const seen = new Set<string>()
  const connectFields = declared.map((raw: unknown): ConnectFieldSnapshot => {
    const field = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const { key, labelKey, label: rawLabel, helpKey, secret, required, multiple } = field
    const label = rawLabel === undefined ? null : readLocalizedText(rawLabel)
    if (
      typeof key !== 'string' ||
      !ChannelConnectFieldLimits.KEY_PATTERN.test(key) ||
      RESERVED_CONNECT_FIELD_KEYS.has(key) ||
      (labelKey !== undefined && !messageKey(labelKey)) ||
      (rawLabel !== undefined && label === null) ||
      (labelKey === undefined && label === null) ||
      (helpKey !== undefined && !messageKey(helpKey)) ||
      typeof secret !== 'boolean' ||
      typeof required !== 'boolean' ||
      typeof multiple !== 'boolean' ||
      seen.has(key)
    ) {
      throw contractViolation(`Plugin ${printable(id)} declares an invalid connect field`)
    }
    seen.add(key)
    return Object.freeze({
      key,
      labelKey: labelKey ?? null,
      label,
      helpKey: helpKey ?? null,
      secret,
      required,
      multiple
    })
  })
  const webhooks: unknown = plugin.receivesProviderWebhooks
  if (typeof webhooks !== 'boolean') {
    throw contractViolation(`Plugin ${printable(id)} does not say whether it receives webhooks`)
  }
  const setup: unknown = plugin.profileSetupKey
  if (setup !== undefined && !messageKey(setup)) {
    throw contractViolation(`Plugin ${printable(id)} declares an invalid profile setup key`)
  }
  // A step to read profiles for a channel that reads none would be dead text the author never learns of
  if (setup !== undefined && !capabilities.includes(ChannelCapability.CUSTOMER_PROFILE)) {
    throw contractViolation(
      `Plugin ${printable(id)} declares a profile setup key without customer_profile`
    )
  }
  return { connectFields, receivesProviderWebhooks: webhooks, profileSetupKey: setup ?? null }
}
