import { MENTION_PREFIX, SLASH_PREFIX, SlashCommand } from '@platform/core/domain'

// What the text of the composer is asking for while the agent types: the command menu after a `/`
// at the start, the list of snippets or members after `/snippet ` or `/assign `, the list of
// teammates after an `@`.

export type SlashQuery =
  // Still choosing the command: `/sn`
  | { kind: 'commands'; text: string }
  // `/snippet gra`, `/assign an`
  | { kind: 'argument'; command: SlashCommand.SNIPPET | SlashCommand.ASSIGN; text: string }

const MENTION_MAX_QUERY_LENGTH = 40
const MENTION_MAX_WORDS = 3

export function commandOf(value: string): SlashCommand | undefined {
  return Object.values(SlashCommand).find(command => String(command) === value)
}

// The command a text starts with, whether or not the agent may use it: `/assign ana` is a command
// even for who cannot assign, and must not go to the customer as a message
export function typedCommand(draft: string): SlashCommand | undefined {
  if (!draft.startsWith(SLASH_PREFIX)) return undefined
  return commandOf(draft.slice(SLASH_PREFIX.length).split(/\s/, 1)[0]?.toLowerCase() ?? '')
}

// A command is only ever the whole text of the box, on one line: a `/` in the middle of a message
// ("and/or", a path) is text
export function slashQuery(draft: string): SlashQuery | null {
  if (!draft.startsWith(SLASH_PREFIX) || draft.includes('\n')) return null
  const body = draft.slice(SLASH_PREFIX.length)
  const space = body.search(/\s/)
  if (space === -1) return { kind: 'commands', text: body.toLowerCase() }
  const name = body.slice(0, space).toLowerCase()
  const command = commandOf(name)
  const text = body.slice(space).trim()
  if (command === SlashCommand.SNIPPET || command === SlashCommand.ASSIGN) {
    return { kind: 'argument', command, text }
  }
  // `/resolve now` and the like: the argument of a command that takes none is ignored, and the menu
  // keeps offering that command
  return command === undefined ? null : { kind: 'commands', text: name }
}

export function matchCommands(text: string, allowed: readonly SlashCommand[]): SlashCommand[] {
  return allowed.filter(command => command.startsWith(text))
}

interface Named {
  name: string
}

// The same rule for any list the agent filters by typing: the start of a word, whatever the case
// and the accents
export function matchesText(candidate: string, text: string): boolean {
  if (text === '') return true
  const fold = (value: string): string =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
  const wanted = fold(text)
  const folded = fold(candidate)
  // The start of the name (so "ana pe" finds "Ana Pérez") or of any word of it
  return folded.startsWith(wanted) || folded.split(/\s+/).some(word => word.startsWith(wanted))
}

export function matchMembers<T extends Named>(members: readonly T[], text: string): T[] {
  return members.filter(member => matchesText(member.name, text))
}

export function matchSnippets<T extends { shortcut: string; title: string }>(
  snippets: readonly T[],
  text: string
): T[] {
  const wanted = text.toLowerCase()
  return snippets.filter(
    snippet => snippet.shortcut.startsWith(wanted) || matchesText(snippet.title, text)
  )
}

export interface MentionQuery {
  // Where the `@` is, to replace from there to the caret
  start: number
  text: string
}

// The `@` the caret is right after, at the start of the text or after a space: `hi @an|`. An `@`
// inside a word (an email address) is not a mention.
export function mentionQuery(draft: string, caret: number): MentionQuery | null {
  const before = draft.slice(0, caret)
  const at = before.lastIndexOf(MENTION_PREFIX)
  if (at === -1) return null
  const previous = before[at - 1]
  if (previous !== undefined && !/\s/.test(previous)) return null
  const text = before.slice(at + MENTION_PREFIX.length)
  // A line break ends it; spaces do not, because a name has several words, but a long run is no name
  if (text.includes('\n') || text.length > MENTION_MAX_QUERY_LENGTH) return null
  // A name has a few words: a longer run after the @ is a sentence, not a name
  if (text.split(/\s+/).length > MENTION_MAX_WORDS) return null
  return { start: at, text }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface Mention {
  id: string
  name: string
}

// The text after choosing a teammate, and where the caret goes
export function insertMention(
  draft: string,
  caret: number,
  query: MentionQuery,
  mention: Mention
): { draft: string; caret: number } {
  const inserted = `${MENTION_PREFIX}${mention.name} `
  return {
    draft: `${draft.slice(0, query.start)}${inserted}${draft.slice(caret)}`,
    caret: query.start + inserted.length
  }
}

// The people already picked plus more, once each
export function withMentions(current: readonly Mention[], more: readonly Mention[]): Mention[] {
  const ids = new Set(current.map(mention => mention.id))
  return [...current, ...more.filter(mention => !ids.has(mention.id))]
}

// The people the note still names: one the agent picked and then deleted from the text is not
// notified
export function mentionedIds(content: string, picked: readonly Mention[]): string[] {
  const ids = new Set<string>()
  for (const mention of picked) {
    // The name must end there: "@Anabel" does not name Ana
    const named = new RegExp(
      `${escapeRegExp(MENTION_PREFIX + mention.name)}(?![\\p{L}\\p{N}_])`,
      'u'
    )
    if (named.test(content)) ids.add(mention.id)
  }
  return [...ids]
}
