import { SlashCommand } from '@platform/core/domain'

import {
  insertMention,
  matchCommands,
  matchMembers,
  matchSnippets,
  type Mention,
  mentionQuery,
  slashQuery
} from './composer-triggers'

// What choosing an entry of the menu does to the composer
export type MenuOutcome =
  | { kind: 'draft'; draft: string; caret: number; mention?: Mention }
  | { kind: 'snooze' }
  | { kind: 'resolve' }
  | { kind: 'assign'; member: Mention }

export interface MenuEntry {
  id: string
  label: string
  hint?: string
  outcome: MenuOutcome
}

export interface ComposerMenu {
  kind: 'commands' | 'snippets' | 'members' | 'mentions'
  entries: MenuEntry[]
}

export interface MenuInput {
  draft: string
  caret: number
  isNote: boolean
  // The commands this agent may use: each action needs its own permission
  commands: readonly SlashCommand[]
  snippets: readonly { id: string; shortcut: string; title: string; content: string }[]
  members: readonly { id: string; name: string; role: { name: string } }[]
  selfId: string | undefined
  // Whether the note already names as many people as one may
  isMentionFull: boolean
  maxLength: number
  commandHint: (command: SlashCommand) => string
}

const SNIPPET_HINT_LENGTH = 80
// A list the agent filters by typing: more than this is a scroll, not a choice
const MENU_MAX_ENTRIES = 20

function commandEntries(input: MenuInput, text: string): MenuEntry[] {
  return matchCommands(text, input.commands).map(command => ({
    id: command,
    label: `/${command}`,
    hint: input.commandHint(command),
    outcome: outcomeOfCommand(command)
  }))
}

function outcomeOfCommand(command: SlashCommand): MenuOutcome {
  if (command === SlashCommand.SNOOZE) return { kind: 'snooze' }
  if (command === SlashCommand.RESOLVE) return { kind: 'resolve' }
  // Snippet and assign ask for more: the box now holds the command and the menu lists its choices
  const draft = `/${command} `
  return { kind: 'draft', draft, caret: draft.length }
}

// The menu the text of the composer asks for, or null when it asks for none. A command is the whole
// text of the box; an `@` belongs to a note, because a mention notifies a teammate and a reply to the
// customer is not read by the team.
export function composerMenu(input: MenuInput): ComposerMenu | null {
  const slash = slashQuery(input.draft)
  if (slash?.kind === 'commands') {
    return { kind: 'commands', entries: commandEntries(input, slash.text) }
  }
  if (slash?.command === SlashCommand.SNIPPET) {
    if (!input.commands.includes(SlashCommand.SNIPPET)) return null
    return {
      kind: 'snippets',
      entries: matchSnippets(input.snippets, slash.text)
        .slice(0, MENU_MAX_ENTRIES)
        .map(snippet => ({
          id: snippet.id,
          label: snippet.title,
          hint: `/${snippet.shortcut} · ${snippet.content.slice(0, SNIPPET_HINT_LENGTH)}`,
          outcome: {
            kind: 'draft',
            draft: snippet.content.slice(0, input.maxLength),
            caret: Math.min(snippet.content.length, input.maxLength)
          }
        }))
    }
  }
  if (slash?.command === SlashCommand.ASSIGN) {
    if (!input.commands.includes(SlashCommand.ASSIGN)) return null
    return {
      kind: 'members',
      entries: matchMembers(input.members, slash.text).map(member => ({
        id: member.id,
        label: member.name,
        hint: member.role.name,
        outcome: { kind: 'assign', member: { id: member.id, name: member.name } }
      }))
    }
  }
  if (!input.isNote || input.isMentionFull) return null
  const query = mentionQuery(input.draft, input.caret)
  if (query === null) return null
  const matching = matchMembers(
    input.members.filter(member => member.id !== input.selfId),
    query.text
  )
  // Nobody matches once the name is complete ("@Ana ") or the @ was not a mention: no menu, no hint
  if (matching.length === 0) return null
  return {
    kind: 'mentions',
    entries: matching.map(member => {
      const mention = { id: member.id, name: member.name }
      return {
        id: member.id,
        label: member.name,
        hint: member.role.name,
        outcome: {
          kind: 'draft',
          ...insertMention(input.draft, input.caret, query, mention),
          mention
        }
      }
    })
  }
}
