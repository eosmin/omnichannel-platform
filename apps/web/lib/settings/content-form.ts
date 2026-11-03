import { SettingsLimits, SNIPPET_SHORTCUT_PATTERN, TAG_COLOR_PATTERN } from '@platform/core/domain'

import type { InboxSettingsInput, InboxSettingsView } from './inbox-requests'
import type { SnippetInput, StoreSnippetView } from './snippets-requests'
import type { StoreTagView, TagInput } from './tags-requests'

// The forms of Settings → Tags, Snippets and Inbox behavior, as plain values, and the checks done
// before the request. The api checks the same and more; it decides.

// As the api: control and invisible format characters are refused, the joiner of emoji (U+200D) is not
const INVISIBLE = /[\p{Cc}\p{Cf}]/u
const JOINER = '\u200d'
const hasInvisible = (text: string): boolean => INVISIBLE.test(text.replaceAll(JOINER, ''))

export const DEFAULT_TAG_COLOR = '#6366f1'

// Tags

export interface TagDraft {
  name: string
  color: string
  description: string
}

export const TagProblems = {
  NAME_REQUIRED: 'nameRequired',
  NAME_TOO_LONG: 'nameTooLong',
  NAME_INVALID: 'nameInvalid',
  COLOR_INVALID: 'colorInvalid',
  DESCRIPTION_TOO_LONG: 'descriptionTooLong',
  DESCRIPTION_INVALID: 'descriptionInvalid'
} as const
export type TagProblem = (typeof TagProblems)[keyof typeof TagProblems]

export function emptyTagDraft(): TagDraft {
  return { name: '', color: DEFAULT_TAG_COLOR, description: '' }
}

export function tagDraftOf(tag: StoreTagView): TagDraft {
  return { name: tag.name, color: tag.color, description: tag.description ?? '' }
}

export function tagProblems(draft: TagDraft): TagProblem[] {
  const problems: TagProblem[] = []
  const name = draft.name.trim()
  if (name.length === 0) problems.push(TagProblems.NAME_REQUIRED)
  else if (name.length > SettingsLimits.TAG_NAME_MAX_LENGTH)
    problems.push(TagProblems.NAME_TOO_LONG)
  else if (hasInvisible(name)) problems.push(TagProblems.NAME_INVALID)
  if (!TAG_COLOR_PATTERN.test(draft.color)) problems.push(TagProblems.COLOR_INVALID)
  const description = draft.description.trim()
  if (description.length > SettingsLimits.TAG_DESCRIPTION_MAX_LENGTH) {
    problems.push(TagProblems.DESCRIPTION_TOO_LONG)
  } else if (hasInvisible(description)) problems.push(TagProblems.DESCRIPTION_INVALID)
  return problems
}

// Field by field, so that nothing the form does not draw can reach the api. An empty description is
// sent as null: that is how the api clears it.
export function tagInputOf(draft: TagDraft): TagInput {
  const description = draft.description.trim()
  return {
    name: draft.name.trim(),
    color: draft.color.toLowerCase(),
    description: description === '' ? null : description
  }
}

// Only what changed: a field the person did not touch must not overwrite what another person saved
export function tagChanges(tag: StoreTagView, draft: TagDraft): Partial<TagInput> {
  const input = tagInputOf(draft)
  const changes: Partial<TagInput> = {}
  if (input.name !== tag.name) changes.name = input.name
  if (input.color !== tag.color.toLowerCase()) changes.color = input.color
  if (input.description !== tag.description) changes.description = input.description
  return changes
}

// Snippets

export interface SnippetDraft {
  shortcut: string
  title: string
  content: string
}

export const SnippetProblems = {
  SHORTCUT_REQUIRED: 'shortcutRequired',
  SHORTCUT_TOO_LONG: 'shortcutTooLong',
  SHORTCUT_INVALID: 'shortcutInvalid',
  TITLE_REQUIRED: 'titleRequired',
  TITLE_TOO_LONG: 'titleTooLong',
  TITLE_INVALID: 'titleInvalid',
  CONTENT_REQUIRED: 'contentRequired',
  CONTENT_TOO_LONG: 'contentTooLong',
  CONTENT_INVALID: 'contentInvalid'
} as const
export type SnippetProblem = (typeof SnippetProblems)[keyof typeof SnippetProblems]

export function emptySnippetDraft(): SnippetDraft {
  return { shortcut: '', title: '', content: '' }
}

export function snippetDraftOf(snippet: StoreSnippetView): SnippetDraft {
  return { shortcut: snippet.shortcut, title: snippet.title, content: snippet.content }
}

// What is typed after the slash, as the api keeps it: lowercase, and a person may type the slash
export function normalizedShortcut(shortcut: string): string {
  return shortcut.trim().replace(/^\//, '').toLowerCase()
}

export function snippetProblems(draft: SnippetDraft): SnippetProblem[] {
  const problems: SnippetProblem[] = []
  const shortcut = normalizedShortcut(draft.shortcut)
  if (shortcut.length === 0) problems.push(SnippetProblems.SHORTCUT_REQUIRED)
  else if (shortcut.length > SettingsLimits.SNIPPET_SHORTCUT_MAX_LENGTH) {
    problems.push(SnippetProblems.SHORTCUT_TOO_LONG)
  } else if (!SNIPPET_SHORTCUT_PATTERN.test(shortcut)) {
    problems.push(SnippetProblems.SHORTCUT_INVALID)
  }
  const title = draft.title.trim()
  if (title.length === 0) problems.push(SnippetProblems.TITLE_REQUIRED)
  else if (title.length > SettingsLimits.SNIPPET_TITLE_MAX_LENGTH) {
    problems.push(SnippetProblems.TITLE_TOO_LONG)
  } else if (hasInvisible(title)) problems.push(SnippetProblems.TITLE_INVALID)
  if (draft.content.trim() === '') problems.push(SnippetProblems.CONTENT_REQUIRED)
  else if (draft.content.includes('\0')) problems.push(SnippetProblems.CONTENT_INVALID)
  else if (draft.content.length > SettingsLimits.SNIPPET_CONTENT_MAX_LENGTH) {
    problems.push(SnippetProblems.CONTENT_TOO_LONG)
  }
  return problems
}

// The message is kept as written (its line breaks are the agent's); only shortcut and title are trimmed
export function snippetInputOf(draft: SnippetDraft): SnippetInput {
  return {
    shortcut: normalizedShortcut(draft.shortcut),
    title: draft.title.trim(),
    content: draft.content
  }
}

export function snippetChanges(
  snippet: StoreSnippetView,
  draft: SnippetDraft
): Partial<SnippetInput> {
  const input = snippetInputOf(draft)
  const changes: Partial<SnippetInput> = {}
  if (input.shortcut !== snippet.shortcut) changes.shortcut = input.shortcut
  if (input.title !== snippet.title) changes.title = input.title
  if (input.content !== snippet.content) changes.content = input.content
  return changes
}

// Inbox behavior

export interface InboxDraft {
  resolveShowOptions: boolean
  sendClosingMessage: boolean
  // '' is no snippet
  closingSnippetId: string
  // false is "a new conversation is never started for a customer who already has one" (null)
  reopenLimited: boolean
  // The numbers are typed: kept as text until they are checked
  reopenWindowDays: string
  autoArchiveAfterDays: string
  agentLoadThreshold: string
}

export const InboxProblems = {
  REOPEN_DAYS: 'reopenDays',
  ARCHIVE_DAYS: 'archiveDays',
  LOAD_THRESHOLD: 'loadThreshold',
  CLOSING_SNIPPET_REQUIRED: 'closingSnippetRequired'
} as const
export type InboxProblem = (typeof InboxProblems)[keyof typeof InboxProblems]

// Shown in the field of the window when the person turns it on for a store that had none
export const DEFAULT_REOPEN_DAYS = 7

export function inboxDraftOf(view: InboxSettingsView): InboxDraft {
  return {
    resolveShowOptions: view.resolveShowOptions,
    sendClosingMessage: view.sendClosingMessage,
    closingSnippetId: view.closingSnippetId ?? '',
    reopenLimited: view.reopenWindowDays !== null,
    reopenWindowDays: String(view.reopenWindowDays ?? DEFAULT_REOPEN_DAYS),
    autoArchiveAfterDays: String(view.autoArchiveAfterDays),
    agentLoadThreshold: String(view.agentLoadThreshold)
  }
}

// A whole number inside the limits, typed as digits only ('1e2' and '7.5' are not days)
function wholeNumber(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const value = Number(text.trim())
  return value >= min && value <= max ? value : null
}

export function inboxProblems(draft: InboxDraft): InboxProblem[] {
  const problems: InboxProblem[] = []
  const days = [SettingsLimits.MIN_DAYS, SettingsLimits.MAX_DAYS] as const
  if (draft.reopenLimited && wholeNumber(draft.reopenWindowDays, ...days) === null) {
    problems.push(InboxProblems.REOPEN_DAYS)
  }
  if (wholeNumber(draft.autoArchiveAfterDays, ...days) === null) {
    problems.push(InboxProblems.ARCHIVE_DAYS)
  }
  if (
    wholeNumber(
      draft.agentLoadThreshold,
      SettingsLimits.MIN_AGENT_LOAD_THRESHOLD,
      SettingsLimits.MAX_AGENT_LOAD_THRESHOLD
    ) === null
  ) {
    problems.push(InboxProblems.LOAD_THRESHOLD)
  }
  // The closing message needs the saved reply it sends. Only the resolve-immediately flow sends one.
  if (draft.sendClosingMessage && draft.closingSnippetId === '') {
    problems.push(InboxProblems.CLOSING_SNIPPET_REQUIRED)
  }
  return problems
}

// What changed in `settings.inbox`, and nothing else: `requestCsat` is never sent. The draft must have
// no problems. Returns {} when nothing changed.
export function inboxChanges(saved: InboxSettingsView, draft: InboxDraft): InboxSettingsInput {
  const changes: InboxSettingsInput = {}
  const days = [SettingsLimits.MIN_DAYS, SettingsLimits.MAX_DAYS] as const
  const reopen = draft.reopenLimited ? wholeNumber(draft.reopenWindowDays, ...days) : null
  if (reopen !== saved.reopenWindowDays) changes.reopenWindowDays = reopen
  const archive = wholeNumber(draft.autoArchiveAfterDays, ...days)
  if (archive !== null && archive !== saved.autoArchiveAfterDays) {
    changes.autoArchiveAfterDays = archive
  }
  const threshold = wholeNumber(
    draft.agentLoadThreshold,
    SettingsLimits.MIN_AGENT_LOAD_THRESHOLD,
    SettingsLimits.MAX_AGENT_LOAD_THRESHOLD
  )
  if (threshold !== null && threshold !== saved.agentLoadThreshold) {
    changes.agentLoadThreshold = threshold
  }
  if (draft.resolveShowOptions !== saved.resolveShowOptions) {
    changes.resolveShowOptions = draft.resolveShowOptions
  }
  if (draft.sendClosingMessage !== saved.sendClosingMessage) {
    changes.sendClosingMessage = draft.sendClosingMessage
  }
  const closing = draft.closingSnippetId === '' ? null : draft.closingSnippetId
  if (closing !== saved.closingSnippetId) changes.closingSnippetId = closing
  return changes
}
