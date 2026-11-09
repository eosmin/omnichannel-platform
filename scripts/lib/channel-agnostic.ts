// Channel-agnostic ratchet (CLAUDE.md rule 13). Core, API, worker, SDK, runtime, web and the api-client
// must not know a channel or Meta: a plugin under libs/channels/* declares what is its own (capabilities,
// manifest, hooks), so that a third party can ship a plugin without editing the platform.
// The knowledge that exists today is frozen in a baseline, per file and split in code and comments,
// that can only shrink.

export interface Counts {
  code: number
  comment: number
}
export type Baseline = Readonly<Record<string, Counts>>

const SCANNED_ROOTS = [
  'apps/web/',
  'apps/api/',
  'apps/worker/',
  'libs/core/',
  'libs/api-client/',
  'libs/plugins/sdk/',
  'libs/plugins/runtime/'
]
// Translations (JSON) are not source: the names a user sees come from the manifest of each plugin
const SCANNED_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|prisma|sql)$/
const EXCLUDED =
  /(\.(spec|test|stories)\.[cm]?[jt]sx?$)|(^|\/)(tests?|__tests__|__mocks__)\/|^apps\/[^/]+-e2e\/|^libs\/core\/database\/(prisma\/migrations|rollbacks)\/|(^|\/)dev-fixtures\.ts$/

// A composition root has to import the plugins to register them. Each entry needs its reason in
// writing; this is not a place to put a file that fails the check.
export const ALLOWED_FILES: Readonly<Record<string, string>> = {
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

// The names of the three channels count as a substring (WhatsAppPlugin, ChannelIds.WHATSAPP). The
// rest are whole words, and "Meta" capitalized, as a quoted id or as the start of an identifier
// (MetaMessaging), but not "metadata", `import.meta` or a `meta` key
const CHANNEL_NAMES = /whatsapp|instagram|messenger|cdninstagram/i
const PROVIDER_WORDS = /\b(facebook|graph\.facebook|wamid|fbcdn|fbsbx|wa_id|phone_number_id)\b/i
// Case matters: `import.meta`, `response.meta` and `<meta>` are not the company
const META_NAME = /\bMeta\b|\bMeta[A-Z]|['"`]meta['"`]/

function matches(line: string): boolean {
  return CHANNEL_NAMES.test(line) || PROVIDER_WORDS.test(line) || META_NAME.test(line)
}

// Lines, not occurrences: a line that names three channels is one reference. A line is a comment when
// it starts with // or lives inside /* */; a trailing comment counts as code, the stricter side
export function countReferences(source: string): Counts {
  const counts: Counts = { code: 0, comment: 0 }
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    const startsBlock = !inBlock && trimmed.startsWith('/*')
    const isComment = inBlock || startsBlock || trimmed.startsWith('//')
    if (startsBlock) inBlock = !trimmed.includes('*/', 2)
    else if (inBlock && trimmed.includes('*/')) inBlock = false
    if (!matches(line)) continue
    if (isComment) counts.comment += 1
    else counts.code += 1
  }
  return counts
}

export interface BaselineFinding {
  file: string
  kind: 'new' | 'grew'
  allowed: Counts
  found: Counts
}

const ZERO: Counts = { code: 0, comment: 0 }
const total = ({ code, comment }: Counts): number => code + comment

// Fails only when a count goes UP: a file without an entry that has matches, or more lines than its
// entry. Fewer lines are accepted, so that parallel pull requests that delete references never turn
// each other red; see `slackOf` for the entries that can be tightened.
export function checkAgainstBaseline(baseline: Baseline, current: Baseline): BaselineFinding[] {
  const findings: BaselineFinding[] = []
  for (const [file, found] of Object.entries(current)) {
    const allowed = baseline[file] ?? ZERO
    if (found.code > allowed.code || found.comment > allowed.comment) {
      findings.push({ file, kind: file in baseline ? 'grew' : 'new', allowed, found })
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file))
}

// Entries above the real count (or of a file that is gone): not a failure, a notice that
// `--update-down` can tighten the baseline
export function slackOf(baseline: Baseline, current: Baseline): string[] {
  return Object.entries(baseline)
    .filter(([file, allowed]) => {
      const found = current[file] ?? ZERO
      return found.code < allowed.code || found.comment < allowed.comment
    })
    .map(([file]) => file)
    .sort()
}

// Files of `next` that are not in `previous` or that have more of either kind
export function baselineGrowth(previous: Baseline, next: Baseline): string[] {
  return Object.entries(next)
    .filter(([file, counts]) => {
      const before = previous[file] ?? ZERO
      return counts.code > before.code || counts.comment > before.comment
    })
    .map(([file]) => file)
    .sort()
}

// The only way the baseline file is written: from the current counts, and never upward
export function lowerBaseline(baseline: Baseline, current: Baseline): Record<string, Counts> {
  const grown = baselineGrowth(baseline, current)
  if (grown.length > 0) throw new Error(`the baseline cannot grow: ${grown.join(', ')}`)
  return Object.fromEntries(
    Object.entries(current)
      .filter(([, counts]) => total(counts) > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
}
