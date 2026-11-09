import {
  type ChannelIconKey,
  ChannelDescriptorLimits,
  type ChannelImageHosts,
  type ChannelManagementSurface,
  DEFAULT_CHANNEL_ICON_KEY,
  isChannelIconKey,
  isChannelManagementSurface,
  isImageHostOrigin,
  type LocalizedText,
  readLocalizedText
} from '@platform/core/domain'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { contractViolation, printable } from './contract-rules'

// What the registry keeps of what the plugin declared to be drawn: a frozen copy, with the defaults filled in
export interface ChannelDescriptorSnapshot {
  readonly displayName: LocalizedText
  readonly iconKey: ChannelIconKey
  readonly anonymousCustomers: boolean
  readonly managementSurface: ChannelManagementSurface | null
  readonly helpSteps: readonly LocalizedText[]
  readonly imageHosts: ChannelImageHosts
}

function readHosts(value: unknown, id: string, which: string): readonly string[] {
  if (value === undefined) return Object.freeze([])
  // Copied before it is checked: what is kept is what was checked, whatever the array does on a second read
  const copy: unknown[] = Array.isArray(value) ? Array.from(value as unknown[]) : []
  if (
    !Array.isArray(value) ||
    copy.length > ChannelDescriptorLimits.MAX_IMAGE_HOSTS ||
    !copy.every(isImageHostOrigin)
  ) {
    throw contractViolation(`Plugin ${printable(id)} declares invalid ${which} image hosts`)
  }
  return Object.freeze([...new Set(copy)])
}

// A third party writes the descriptor and the interface draws it, so it is copied once and held to a shape; a
// plugin that declares something invalid is refused at boot like one that lacks a method. Nothing the plugin
// wrote is printed in the error.
export function snapshotChannelDescriptor(
  plugin: ChannelPlugin,
  id: string
): ChannelDescriptorSnapshot {
  const refuse = (what: string): never => {
    throw contractViolation(`Plugin ${printable(id)} declares an invalid ${what}`)
  }
  const declaredName: unknown = plugin.displayName
  let displayName: LocalizedText
  if (declaredName === undefined) {
    // Named by its `name`, in both languages. `name` was never held to a shape (the api cleans it where it shows
    // it), so one that is not plain text is not a reason to refuse the plugin: it is named by its id then.
    displayName =
      readLocalizedText({ es: plugin.name, en: plugin.name }) ??
      readLocalizedText({ es: id, en: id }) ??
      refuse('name')
  } else {
    displayName = readLocalizedText(declaredName) ?? refuse('display name')
  }
  const icon: unknown = plugin.iconKey
  if (icon !== undefined && !isChannelIconKey(icon)) refuse('icon')
  const anonymous: unknown = plugin.anonymousCustomers
  if (anonymous !== undefined && typeof anonymous !== 'boolean') refuse('anonymous flag')
  const surface: unknown = plugin.managementSurface
  if (surface !== undefined && !isChannelManagementSurface(surface)) refuse('management surface')
  const help: unknown = plugin.connectHelp
  const steps: unknown[] =
    help === undefined ? [] : Array.isArray(help) ? Array.from(help as unknown[]) : [null]
  if (steps.length > ChannelDescriptorLimits.MAX_HELP_STEPS) refuse('help')
  const helpSteps = steps.map(
    step => readLocalizedText(step, ChannelDescriptorLimits.HELP_MAX_LENGTH) ?? refuse('help step')
  )
  const hosts: unknown = plugin.imageHosts
  if (
    hosts !== undefined &&
    (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts))
  ) {
    refuse('image hosts block')
  }
  const block = (hosts ?? {}) as Record<string, unknown>
  return Object.freeze({
    displayName,
    iconKey: (icon as ChannelIconKey | undefined) ?? DEFAULT_CHANNEL_ICON_KEY,
    anonymousCustomers: (anonymous as boolean | undefined) ?? false,
    managementSurface: (surface as ChannelManagementSurface | undefined) ?? null,
    helpSteps: Object.freeze(helpSteps),
    imageHosts: Object.freeze({
      avatar: readHosts(block['avatar'], id, 'avatar'),
      media: readHosts(block['media'], id, 'media')
    })
  })
}
