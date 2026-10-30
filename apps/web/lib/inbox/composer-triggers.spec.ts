import { SlashCommand } from '@platform/core/domain'

import {
  insertMention,
  matchCommands,
  matchMembers,
  matchSnippets,
  mentionedIds,
  mentionQuery,
  slashQuery,
  typedCommand,
  withMentions
} from './composer-triggers'

describe('slashQuery', () => {
  it('offers the commands while the name is being typed', () => {
    expect(slashQuery('/')).toEqual({ kind: 'commands', text: '' })
    expect(slashQuery('/SnO')).toEqual({ kind: 'commands', text: 'sno' })
  })

  it('reads the argument of snippet and assign', () => {
    expect(slashQuery('/snippet gra')).toEqual({
      kind: 'argument',
      command: SlashCommand.SNIPPET,
      text: 'gra'
    })
    expect(slashQuery('/assign  Ana Pé')).toEqual({
      kind: 'argument',
      command: SlashCommand.ASSIGN,
      text: 'Ana Pé'
    })
  })

  it('ignores the argument of a command that takes none', () => {
    expect(slashQuery('/resolve now')).toEqual({ kind: 'commands', text: 'resolve' })
  })

  it.each(['hello /snippet', 'a/b', '/snippet x\nmore', '/nothing here', ''])(
    'is not a command: %p',
    draft => {
      expect(slashQuery(draft)).toBeNull()
    }
  )
})

describe('matchCommands', () => {
  it('keeps the allowed commands that start with the text', () => {
    const allowed = [SlashCommand.SNIPPET, SlashCommand.SNOOZE, SlashCommand.RESOLVE]

    expect(matchCommands('sn', allowed)).toEqual([SlashCommand.SNIPPET, SlashCommand.SNOOZE])
    expect(matchCommands('assign', allowed)).toEqual([])
  })
})

describe('matching by typing', () => {
  it('finds a member by the start of any word of the name, without case or accents', () => {
    const members = [{ name: 'Ana Pérez' }, { name: 'Luis Ana' }, { name: 'Bea' }]

    expect(matchMembers(members, 'per')).toEqual([{ name: 'Ana Pérez' }])
    expect(matchMembers(members, 'ANA')).toEqual([{ name: 'Ana Pérez' }, { name: 'Luis Ana' }])
    expect(matchMembers(members, '')).toHaveLength(3)
    expect(matchMembers(members, 'ana pe')).toEqual([{ name: 'Ana Pérez' }])
  })

  it('finds a snippet by its shortcut or a word of its title', () => {
    const snippets = [
      { shortcut: 'gracias', title: 'Thanks' },
      { shortcut: 'hola', title: 'Greeting' }
    ]

    expect(matchSnippets(snippets, 'gra')).toEqual([snippets[0]])
    expect(matchSnippets(snippets, 'gree')).toEqual([snippets[1]])
  })
})

describe('mentionQuery', () => {
  it('finds the @ the caret is after', () => {
    expect(mentionQuery('hi @an', 6)).toEqual({ start: 3, text: 'an' })
    expect(mentionQuery('@', 1)).toEqual({ start: 0, text: '' })
  })

  it('keeps going through the spaces of a name', () => {
    expect(mentionQuery('ask @Ana Pé', 11)).toEqual({ start: 4, text: 'Ana Pé' })
  })

  it('is not a mention inside a word, or across a line break, or with no @ before the caret', () => {
    expect(mentionQuery('me@example.com', 14)).toBeNull()
    expect(mentionQuery('@ana\nnext', 9)).toBeNull()
    expect(mentionQuery('hello', 5)).toBeNull()
    expect(mentionQuery('@ana and then more text here that is no name at all', 52)).toBeNull()
  })
})

describe('insertMention', () => {
  it('replaces what was typed with the name and puts the caret after it', () => {
    const query = { start: 3, text: 'an' }

    expect(insertMention('hi @an, ok', 6, query, { id: 'u1', name: 'Ana' })).toEqual({
      draft: 'hi @Ana , ok',
      caret: 8
    })
  })
})

describe('typedCommand', () => {
  it('names the command a text starts with, whatever follows', () => {
    expect(typedCommand('/Assign ana')).toBe(SlashCommand.ASSIGN)
    expect(typedCommand('/resolve')).toBe(SlashCommand.RESOLVE)
  })

  it.each(['hello', '/unknown x', 'a /assign', ''])('is none for %p', draft => {
    expect(typedCommand(draft)).toBeUndefined()
  })
})

describe('mentionedIds', () => {
  it('does not take a longer name for a shorter one', () => {
    expect(mentionedIds('hi @Anabel', [{ id: 'u1', name: 'Ana' }])).toEqual([])
    expect(mentionedIds('hi @Ana, ok', [{ id: 'u1', name: 'Ana' }])).toEqual(['u1'])
  })

  it('drops a person whose name the agent deleted from the text, and repeats nobody', () => {
    const picked = [
      { id: 'u1', name: 'Ana' },
      { id: 'u2', name: 'Luis' },
      { id: 'u1', name: 'Ana' }
    ]

    expect(mentionedIds('ping @Ana please', picked)).toEqual(['u1'])
  })
})

describe('withMentions', () => {
  it('adds the people once, by id', () => {
    const ana = { id: 'u1', name: 'Ana' }

    expect(withMentions([ana], [ana, { id: 'u2', name: 'Luis' }])).toEqual([
      ana,
      { id: 'u2', name: 'Luis' }
    ])
  })
})
