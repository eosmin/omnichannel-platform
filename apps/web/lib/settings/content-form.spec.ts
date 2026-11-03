import {
  inboxChanges,
  inboxDraftOf,
  inboxProblems,
  InboxProblems,
  normalizedShortcut,
  snippetChanges,
  snippetInputOf,
  snippetProblems,
  SnippetProblems,
  tagChanges,
  tagInputOf,
  tagProblems,
  TagProblems
} from './content-form'
import type { InboxSettingsView } from './inbox-requests'

const tag = { id: 't1', name: 'VIP', color: '#AABBCC', description: null }
const snippet = {
  id: 's1',
  shortcut: 'gracias',
  title: 'Thanks',
  content: 'Hello\n',
  updatedAt: '2026-11-03T10:00:00.000Z'
}
const inbox: InboxSettingsView = {
  reopenWindowDays: null,
  autoArchiveAfterDays: 30,
  resolveShowOptions: true,
  sendClosingMessage: false,
  closingSnippetId: null,
  agentLoadThreshold: 8
}

describe('tag form', () => {
  it('checks name, colour and description before the request', () => {
    expect(tagProblems({ name: ' ', color: '#aabbcc', description: '' })).toEqual([
      TagProblems.NAME_REQUIRED
    ])
    expect(
      tagProblems({ name: 'a'.repeat(61), color: 'red', description: 'x'.repeat(256) })
    ).toEqual([
      TagProblems.NAME_TOO_LONG,
      TagProblems.COLOR_INVALID,
      TagProblems.DESCRIPTION_TOO_LONG
    ])
    expect(tagProblems({ name: 'a\nb', color: '#aabbcc', description: '' })).toEqual([
      TagProblems.NAME_INVALID
    ])
    expect(tagProblems({ name: 'VIP', color: '#aabbcc', description: 'ok' })).toEqual([])
  })

  it('trims, lowercases the colour and sends an empty description as null', () => {
    expect(tagInputOf({ name: ' VIP ', color: '#AABBCC', description: '  ' })).toEqual({
      name: 'VIP',
      color: '#aabbcc',
      description: null
    })
  })

  it('sends only what changed, and compares the colour without case', () => {
    expect(tagChanges(tag, { name: 'VIP', color: '#aabbcc', description: '' })).toEqual({})
    expect(tagChanges(tag, { name: 'VIP 2', color: '#aabbcc', description: 'Top' })).toEqual({
      name: 'VIP 2',
      description: 'Top'
    })
  })
})

describe('snippet form', () => {
  it('lowercases the shortcut and accepts a typed slash', () => {
    expect(normalizedShortcut(' /Gracias ')).toBe('gracias')
  })

  it('refuses what the api refuses', () => {
    expect(snippetProblems({ shortcut: '/', title: ' ', content: '  \n' })).toEqual([
      SnippetProblems.SHORTCUT_REQUIRED,
      SnippetProblems.TITLE_REQUIRED,
      SnippetProblems.CONTENT_REQUIRED
    ])
    expect(snippetProblems({ shortcut: 'a b', title: 't', content: 'c' })).toEqual([
      SnippetProblems.SHORTCUT_INVALID
    ])
    // Letters from another script that look Latin are not accepted
    expect(snippetProblems({ shortcut: 'gracіas', title: 't', content: 'c' })).toEqual([
      SnippetProblems.SHORTCUT_INVALID
    ])
    expect(
      snippetProblems({
        shortcut: 'a'.repeat(33),
        title: 't'.repeat(121),
        content: 'c'.repeat(4097)
      })
    ).toEqual([
      SnippetProblems.SHORTCUT_TOO_LONG,
      SnippetProblems.TITLE_TOO_LONG,
      SnippetProblems.CONTENT_TOO_LONG
    ])
  })

  it('refuses invisible characters but keeps the emoji joiner, and a NUL in the message', () => {
    expect(snippetProblems({ shortcut: 'a', title: 'a\u200bb', content: 'c' })).toEqual([
      SnippetProblems.TITLE_INVALID
    ])
    expect(snippetProblems({ shortcut: 'a', title: '👩\u200d💻', content: 'c' })).toEqual([])
    expect(snippetProblems({ shortcut: 'a', title: 't', content: 'c\0d' })).toEqual([
      SnippetProblems.CONTENT_INVALID
    ])
    expect(tagProblems({ name: 'a\u202eb', color: '#aabbcc', description: '' })).toEqual([
      TagProblems.NAME_INVALID
    ])
  })

  it('keeps the message as written and trims the rest', () => {
    expect(snippetInputOf({ shortcut: '/Hi', title: ' T ', content: ' a\nb \n' })).toEqual({
      shortcut: 'hi',
      title: 'T',
      content: ' a\nb \n'
    })
  })

  it('sends only what changed', () => {
    expect(
      snippetChanges(snippet, { shortcut: 'GRACIAS', title: 'Thanks', content: 'Hello\n' })
    ).toEqual({})
    expect(
      snippetChanges(snippet, { shortcut: 'gracias', title: 'Thanks', content: 'Bye' })
    ).toEqual({
      content: 'Bye'
    })
  })
})

describe('inbox form', () => {
  it('starts from what the api holds: no window means the toggle is off', () => {
    const draft = inboxDraftOf(inbox)
    expect(draft.reopenLimited).toBe(false)
    expect(draft.autoArchiveAfterDays).toBe('30')
    expect(inboxChanges(inbox, draft)).toEqual({})
    expect(inboxProblems(draft)).toEqual([])
  })

  it('sends null to remove the window and a number to set it', () => {
    const limited: InboxSettingsView = { ...inbox, reopenWindowDays: 7 }
    expect(inboxChanges(limited, { ...inboxDraftOf(limited), reopenLimited: false })).toEqual({
      reopenWindowDays: null
    })
    expect(
      inboxChanges(inbox, { ...inboxDraftOf(inbox), reopenLimited: true, reopenWindowDays: '14' })
    ).toEqual({ reopenWindowDays: 14 })
  })

  it('never includes requestCsat, whatever else changes', () => {
    const changes = inboxChanges(inbox, {
      ...inboxDraftOf(inbox),
      resolveShowOptions: false,
      sendClosingMessage: true,
      closingSnippetId: 'sn1',
      autoArchiveAfterDays: '10',
      agentLoadThreshold: '12'
    })
    expect(changes).toEqual({
      resolveShowOptions: false,
      sendClosingMessage: true,
      closingSnippetId: 'sn1',
      autoArchiveAfterDays: 10,
      agentLoadThreshold: 12
    })
    expect(changes).not.toHaveProperty('requestCsat')
  })

  it('refuses numbers that are not whole days inside the limits', () => {
    const base = inboxDraftOf(inbox)
    expect(inboxProblems({ ...base, autoArchiveAfterDays: '0' })).toEqual([
      InboxProblems.ARCHIVE_DAYS
    ])
    expect(inboxProblems({ ...base, autoArchiveAfterDays: '366' })).toEqual([
      InboxProblems.ARCHIVE_DAYS
    ])
    expect(inboxProblems({ ...base, autoArchiveAfterDays: '7.5' })).toEqual([
      InboxProblems.ARCHIVE_DAYS
    ])
    expect(inboxProblems({ ...base, autoArchiveAfterDays: '1e2' })).toEqual([
      InboxProblems.ARCHIVE_DAYS
    ])
    expect(inboxProblems({ ...base, agentLoadThreshold: '101' })).toEqual([
      InboxProblems.LOAD_THRESHOLD
    ])
    expect(inboxProblems({ ...base, reopenLimited: true, reopenWindowDays: '' })).toEqual([
      InboxProblems.REOPEN_DAYS
    ])
    // An unlimited window ignores whatever is left in the field
    expect(inboxProblems({ ...base, reopenLimited: false, reopenWindowDays: 'abc' })).toEqual([])
  })

  it('needs a snippet to send a closing message, as the api does', () => {
    expect(inboxProblems({ ...inboxDraftOf(inbox), sendClosingMessage: true })).toEqual([
      InboxProblems.CLOSING_SNIPPET_REQUIRED
    ])
  })
})
