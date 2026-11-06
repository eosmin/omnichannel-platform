import {
  CapabilityOfMediaKind,
  type ChannelMediaKind,
  ChannelMediaKinds,
  ChannelMediaLimits,
  type ChannelMediaRule
} from '@platform/core/channel-media'
import { type ChannelCapabilityType } from '@platform/core/domain'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { contractViolation, printable } from './contract-rules'

const KINDS = Object.values(ChannelMediaKinds)
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

// What the core keeps of the files a plugin takes: a deep, frozen copy of the DECLARATION taken once, when the
// plugin passed its contract. A plugin that grows its list or its limits afterwards does not change what the
// platform lets an agent attach. null for a plugin that declares no kind of file.
export type ChannelMediaSnapshot = Readonly<{
  maxFilesPerMessage: number
  kinds: Readonly<Partial<Record<ChannelMediaKind, Readonly<ChannelMediaRule>>>>
}>

// The rules of the kinds a channel declares as capabilities, and only those: a rule without its capability
// would promise a file the interface never offers, and a capability without a rule would leave the limit to
// the provider. A declaration that does not fit is refused at boot, like a method that is missing, and nothing
// of it is printed (it is not trusted).
export function snapshotChannelMedia(
  plugin: ChannelPlugin,
  id: string,
  capabilities: readonly ChannelCapabilityType[]
): ChannelMediaSnapshot | null {
  const declared: unknown = plugin.media
  const needed = KINDS.filter(kind => capabilities.includes(CapabilityOfMediaKind[kind]))
  const refuse = (what: string): never => {
    throw contractViolation(`Plugin ${printable(id)} declares invalid media ${what}`)
  }
  if (declared === undefined) {
    if (needed.length > 0) refuse('(a kind of file is a capability but has no rule)')
    return null
  }
  // A channel that takes no file declares nothing: an empty block would read as "takes files" to a consumer
  if (needed.length === 0) refuse('(the channel declares no kind of file as a capability)')
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) refuse('block')
  const block = declared as Record<string, unknown>
  const max = block['maxFilesPerMessage']
  if (
    typeof max !== 'number' ||
    !Number.isInteger(max) ||
    max < 1 ||
    max > ChannelMediaLimits.MAX_FILES_PER_MESSAGE
  ) {
    refuse('maxFilesPerMessage')
  }
  const kinds = block['kinds']
  if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) refuse('kinds')
  const rules = kinds as Record<string, unknown>
  const declaredKinds = Object.keys(rules)
  if (
    declaredKinds.length !== needed.length ||
    !declaredKinds.every(kind => needed.some(wanted => wanted === kind))
  ) {
    refuse('kinds (they must be the kinds the channel declares as capabilities)')
  }
  const copy: Partial<Record<ChannelMediaKind, Readonly<ChannelMediaRule>>> = {}
  for (const kind of needed) copy[kind] = Object.freeze(copyRule(rules[kind], refuse))
  return Object.freeze({
    maxFilesPerMessage: max as number,
    kinds: Object.freeze(copy)
  })
}

function copyRule(raw: unknown, refuse: (what: string) => never): ChannelMediaRule {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) refuse('rule')
  const rule = raw as Record<string, unknown>
  const maxBytes = rule['maxBytes']
  if (
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > ChannelMediaLimits.MAX_BYTES
  ) {
    refuse('maxBytes')
  }
  const declared = rule['types']
  if (declared === null) return { types: null, maxBytes }
  // Copied once, holes and all, and the copy is what is checked: a list read three times could answer a different
  // thing each time, and `every` skips the holes of a sparse array
  const types: unknown[] = Array.isArray(declared) ? Array.from(declared as unknown[]) : []
  if (
    types.length === 0 ||
    types.length > ChannelMediaLimits.MAX_TYPES ||
    !types.every(
      (type: unknown) =>
        typeof type === 'string' &&
        type.length <= ChannelMediaLimits.MAX_TYPE_LENGTH &&
        CONTENT_TYPE.test(type)
    ) ||
    new Set<unknown>(types).size !== types.length
  ) {
    refuse('types')
  }
  return { types: Object.freeze(types as string[]), maxBytes }
}
