// Carrier-agnostic ratchet (CLAUDE.md rule 13, extended to carriers). Core, API, worker, SDK, runtime, web,
// the api-client and the channel plugins must not know a concrete carrier: a plugin under libs/carriers/*
// declares what is its own (capabilities, manifest, hooks, status mappings), so that a third party can ship a
// carrier without editing the platform. The knowledge that exists today is frozen in a baseline, per file and
// split in code and comments, that can only shrink (the arithmetic is the one of the channel ratchet).
//
// The carriers come from the CarrierId constant of libs/core: a new official carrier is a line there and
// this validator learns it by itself.
import { CarrierId } from '@platform/core/domain'

import { type Baseline, type Counts, countMatchingLines } from './channel-agnostic'

export type { Baseline, Counts }
export { baselineGrowth, checkAgainstBaseline, lowerBaseline, slackOf } from './channel-agnostic'

const SCANNED_ROOTS = [
  'apps/web/',
  'apps/api/',
  'apps/worker/',
  'libs/core/',
  'libs/api-client/',
  'libs/channels/',
  'libs/plugins/sdk/',
  'libs/plugins/runtime/'
]
// Translations (JSON) are not source: the names a user sees come from the manifest of each plugin
const SCANNED_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|prisma|sql)$/
// Contract tests and fixtures name the carrier they exercise on purpose; the baseline of the channel ratchet
// leaves out the same files. Migrations and their rollbacks are history, and cannot be edited
const EXCLUDED =
  /(\.(spec|test|stories)\.[cm]?[jt]sx?$)|(^|\/)(tests?|__tests__|__mocks__)\/|^apps\/[^/]+-e2e\/|^libs\/core\/database\/(prisma\/migrations|rollbacks)\/|(^|\/)dev-fixtures\.ts$/

// Each entry needs its reason in writing; this is not a place to put a file that fails the check.
export const ALLOWED_FILES: Readonly<Record<string, string>> = {
  'libs/core/domain/shipping-constants.ts':
    'Defines CarrierId, the list this validator reads: the ids of the official carriers have to be written once, here. Its comments that explain a carrier of that list are not knowledge of the platform.',
  'libs/plugins/runtime/src/official-plugins.ts':
    'Composition root: the one place that imports the official plugins to register them; nothing else may.'
}

export function isScanned(file: string): boolean {
  return (
    SCANNED_ROOTS.some(root => file.startsWith(root)) &&
    SCANNED_EXTENSIONS.test(file) &&
    !EXCLUDED.test(file) &&
    !(file in ALLOWED_FILES)
  )
}

// An id that is also an ordinary word (`local`: "local time", a private TLD) is a carrier only when it is
// quoted or in backticks on a line that talks about shipping; the others (forza, c807) are carriers wherever
// they appear. A new official carrier whose id is an ordinary word (`manual`, `test`) must be added here, or
// every use of the word would count: `carrier-agnostic.spec.ts` lists the ids so that a new one is noticed.
export const ORDINARY_WORD_IDS: readonly string[] = [CarrierId.LOCAL]
const SHIPPING_WORDS = /(carrier|courier|guide|shipment|shipping)/i

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const KEYS = Object.keys(CarrierId)
const ids = Object.values(CarrierId) as string[]
// CarrierId.FORZA, CarrierId['FORZA']
const KEY_REFERENCE = new RegExp(
  `\\bCarrierId(?:\\.|\\[\\s*['"\`])(?:${KEYS.map(escape).join('|')})\\b`
)
// The package or folder of a carrier plugin: @platform/carriers/local, libs/carriers/forza
const PLUGIN_PATH = new RegExp(`carriers/(?:${ids.map(escape).join('|')})(?![a-z0-9])`, 'i')
const DISTINCTIVE = ids.filter(id => !ORDINARY_WORD_IDS.includes(id))
const DISTINCTIVE_NAME = new RegExp(`${DISTINCTIVE.map(escape).join('|')}`, 'gi')
const HEX_GROUPS = /[0-9a-f]-$/i
// The id as a word or inside an identifier (forzaAdapter, isForza, getC807Client, FORZA_ID), never inside a
// longer word (reinforza, forzas, forza2) nor between the groups of a UUID or a hash
function namesDistinctive(line: string): boolean {
  for (const found of line.matchAll(DISTINCTIVE_NAME)) {
    const at = found.index
    const before = line.slice(0, at)
    const prev = before.charAt(before.length - 1)
    const next = line.charAt(at + found[0].length)
    const startsWord =
      !/[a-z0-9]/i.test(prev) || (/[A-Z]/.test(found[0].charAt(0)) && /[a-z]/.test(prev))
    if (!startsWord || /[a-z0-9]/.test(next)) continue
    if (HEX_GROUPS.test(before) && /^-[0-9a-f]/i.test(line.slice(at + found[0].length))) continue
    return true
  }
  return false
}
const ORDINARY_QUOTED = new RegExp(`['"\`](?:${ORDINARY_WORD_IDS.map(escape).join('|')})['"\`]`)
// Identifiers made from an ordinary-word id and a carrier word: localCarrierPlugin, LocalCarrier
const ORDINARY_IDENTIFIER = new RegExp(
  `(?:${ORDINARY_WORD_IDS.map(escape).join('|')})(?:Carrier|Courier)`,
  'i'
)

export function namesCarrier(line: string): boolean {
  return (
    KEY_REFERENCE.test(line) ||
    PLUGIN_PATH.test(line) ||
    namesDistinctive(line) ||
    ORDINARY_IDENTIFIER.test(line) ||
    (ORDINARY_QUOTED.test(line) && SHIPPING_WORDS.test(line))
  )
}

export function countReferences(source: string): Counts {
  return countMatchingLines(source, namesCarrier)
}
