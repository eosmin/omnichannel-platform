import {
  type ChannelIdentityKind,
  ChannelIdentityKinds,
  type ChannelLimits,
  type ChannelLimitsView,
  MessageLimits,
  MessageType
} from '@platform/core/domain'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { contractViolation, printable } from './contract-rules'

// Only a file carries a caption, so only a kind of file can be declared without one
const FILE_TYPES: ReadonlySet<unknown> = new Set([
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
])
const IDENTITY_KINDS: ReadonlySet<unknown> = new Set(Object.values(ChannelIdentityKinds))

function boundedLength(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MessageLimits.CONTENT_MAX_LENGTH
  )
}

// A plugin of a third party writes its limits, and the api refuses or accepts a reply by them: they are
// copied once, property by property, and held to what the platform stores. A plugin that declares
// nothing valid is refused at boot, like one that lacks a method.
export function snapshotChannelLimits(plugin: ChannelPlugin, id: string): ChannelLimitsView {
  const declared: unknown = plugin.limits
  if (typeof declared !== 'object' || declared === null) {
    throw contractViolation(`Plugin ${printable(id)} does not declare its limits`)
  }
  const { textMaxLength, caption } = declared as Partial<Record<keyof ChannelLimits, unknown>>
  if (!boundedLength(textMaxLength)) {
    throw contractViolation(`Plugin ${printable(id)} declares an invalid text limit`)
  }
  // Absent and null both mean "no rule of its own"
  if (caption === undefined || caption === null) {
    return Object.freeze({ textMaxLength, caption: null })
  }
  const rule: Record<string, unknown> =
    typeof caption === 'object' ? (caption as Record<string, unknown>) : {}
  const { maxLength } = rule
  // Copied before it is checked: what is stored is what was checked, whatever the array does on a second read
  const kinds: unknown = rule.withoutCaption
  const copy: unknown[] = Array.isArray(kinds) ? Array.from(kinds as unknown[]) : []
  if (
    !boundedLength(maxLength) ||
    maxLength > textMaxLength ||
    !Array.isArray(kinds) ||
    copy.length > FILE_TYPES.size ||
    !copy.every(kind => FILE_TYPES.has(kind))
  ) {
    throw contractViolation(
      `Plugin ${printable(id)} declares invalid caption limits (omit caption, or give a length and the kinds of file with none)`
    )
  }
  return Object.freeze({
    textMaxLength,
    caption: Object.freeze({
      maxLength,
      withoutCaption: Object.freeze([...new Set(copy as MessageType[])])
    })
  })
}

export function snapshotIdentityKind(plugin: ChannelPlugin, id: string): ChannelIdentityKind {
  const kind: unknown = plugin.identityKind
  if (!IDENTITY_KINDS.has(kind)) {
    throw contractViolation(`Plugin ${printable(id)} declares an invalid identity kind`)
  }
  return kind as ChannelIdentityKind
}
