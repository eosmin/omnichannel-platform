// Fiscal-agnostic ratchet (CLAUDE.md rule 13, extended to fiscal documents; Step 4B.7). Core, API, worker, SDK, runtime, web, the
// api-client and the other plugins must not know a country's electronic document, its authority or a concrete provider: a provider
// package under libs/fiscal/<provider> declares what is its own (document types, required fields, format, signature) in its manifest, so
// that the real provider for another country is a new package and a line in the composition root, with no edit to the platform.
// The knowledge that exists today is frozen in a baseline, per file and split in code and comments, that can only shrink (the
// arithmetic is the one of the channel ratchet).
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
  'libs/carriers/',
  'libs/plugins/',
  'libs/fiscal/sdk/',
  'libs/fiscal/runtime/'
]
const SCANNED_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|prisma|sql)$/
const EXCLUDED =
  /(\.(spec|test|stories)\.[cm]?[jt]sx?$)|(^|\/)(tests?|__tests__|__mocks__)\/|^apps\/[^/]+-e2e\/|^libs\/core\/database\/(prisma\/migrations|rollbacks)\/|(^|\/)dev-fixtures\.ts$/

// Each entry needs its reason in writing; this is not a place to put a file that fails the check.
export const ALLOWED_FILES: Readonly<Record<string, string>> = {
  'libs/fiscal/runtime/src/official-providers.ts':
    'Composition root: the one place that imports the provider packages to register them; nothing else may.'
}

export function isScanned(file: string): boolean {
  return (
    SCANNED_ROOTS.some(root => file.startsWith(root)) &&
    SCANNED_EXTENSIONS.test(file) &&
    !EXCLUDED.test(file) &&
    !(file in ALLOWED_FILES)
  )
}

// The authorities and the documents of the countries a provider could serve, by name (the acronyms are case-sensitive: `nit` is an
// ordinary word in English), and the package or folder of a provider: @platform/fiscal/<provider>, libs/fiscal/<provider>.
const AUTHORITIES = /\b(?:hacienda|dgii|afip|sunat|sii\.cl)\b/i
const ACRONYMS = /\b(?:DTE|NRC|NIT|DUI|CCF|DIAN)\b/
const PROVIDER_PATH =
  /(?:@platform\/fiscal|libs\/fiscal)\/(?!(?:sdk|runtime)(?![a-z0-9-]))[a-z0-9-]+/
// The simulator is a provider like the others: its id, quoted, or its package
const SIMULATOR_ID = /['"`]simulator['"`]|SIMULATOR_PROVIDER_ID|SimulatorProvider|simulatorProvider/

export function namesFiscalProvider(line: string): boolean {
  return (
    AUTHORITIES.test(line) ||
    ACRONYMS.test(line) ||
    PROVIDER_PATH.test(line) ||
    SIMULATOR_ID.test(line)
  )
}

export function countReferences(source: string): Counts {
  return countMatchingLines(source, namesFiscalProvider)
}
