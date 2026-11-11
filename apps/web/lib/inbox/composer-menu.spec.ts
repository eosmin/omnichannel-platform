import { SlashCommand } from '@platform/core/domain'

import { composerMenu, type MenuInput } from './composer-menu'

const base: MenuInput = {
  draft: '',
  caret: 0,
  isNote: false,
  commands: [SlashCommand.SNIPPET, SlashCommand.ASSIGN, SlashCommand.SNOOZE, SlashCommand.RESOLVE],
  snippets: [
    { id: 'n1', shortcut: 'gracias', title: 'Thanks', content: 'Thank you for writing!' },
    { id: 'n2', shortcut: 'hola', title: 'Greeting', content: 'Hello' }
  ],
  products: [
    { id: 'p1', label: 'Red shirt', hint: 'SKU-1', text: 'Red shirt (M) - $19.99' },
    { id: 'p2', label: 'Blue cap', hint: 'SKU-2', text: 'Blue cap - $9.00' }
  ],
  members: [
    { id: 'u1', name: 'Ana Pérez', role: { name: 'Agent' }, canBeAssigned: true },
    { id: 'u2', name: 'Luis', role: { name: 'Admin' }, canBeAssigned: true }
  ],
  selfId: 'u2',
  isMentionFull: false,
  maxLength: 20,
  commandHint: command => `hint ${command}`,
  roleLabel: roleName => (roleName === 'Agent' ? 'Agente' : roleName)
}

const menu = (changes: Partial<MenuInput>) => composerMenu({ ...base, ...changes })

describe('composerMenu products', () => {
  const withProducts = { commands: [SlashCommand.PRODUCT] }

  it('offers /product, and its Spanish name, only to who may read products', () => {
    expect(
      menu({ draft: '/prod', commands: [SlashCommand.PRODUCT] })?.entries.map(entry => entry.label)
    ).toEqual(['/product'])
    expect(
      menu({ draft: '/produ', commands: [SlashCommand.PRODUCT] })?.entries.map(entry => entry.id)
    ).toEqual([SlashCommand.PRODUCT])
    expect(menu({ draft: '/prod', commands: [SlashCommand.SNIPPET] })?.entries).toEqual([])
  })

  it('lists the products the search answered and puts the text of one in the box, cut to the limit', () => {
    const result = menu({ draft: '/product red', maxLength: 12, ...withProducts })

    expect(result?.kind).toBe('products')
    expect(result?.entries.map(entry => entry.label)).toEqual(['Red shirt', 'Blue cap'])
    expect(result?.entries[0]?.outcome).toEqual({
      kind: 'draft',
      draft: 'Red shirt (M',
      caret: 12
    })
  })

  it('gives no menu for /product to who may not read products', () => {
    expect(menu({ draft: '/product red', commands: [SlashCommand.SNIPPET] })).toBeNull()
  })

  it('answers the Spanish name as the English one', () => {
    expect(menu({ draft: '/producto red', ...withProducts })?.kind).toBe('products')
  })
})

describe('composerMenu', () => {
  it('offers only the commands the agent may use', () => {
    const result = menu({ draft: '/s', commands: [SlashCommand.SNIPPET, SlashCommand.SNOOZE] })

    expect(result?.entries.map(entry => entry.label)).toEqual(['/snippet', '/snooze'])
    expect(result?.entries[0]?.hint).toBe('hint snippet')
  })

  it('opens the dialogs for snooze and resolve, and asks for more on snippet and assign', () => {
    const entries = menu({ draft: '/' })?.entries ?? []

    expect(entries.find(entry => entry.label === '/snooze')?.outcome).toEqual({
      kind: 'snooze'
    })
    expect(entries.find(entry => entry.label === '/resolve')?.outcome).toEqual({
      kind: 'resolve'
    })
    expect(entries.find(entry => entry.label === '/snippet')?.outcome).toEqual({
      kind: 'draft',
      draft: '/snippet ',
      caret: 9
    })
  })

  it('lists the snippets that match and puts the content in the box, cut to the limit', () => {
    const result = menu({ draft: '/snippet gra' })

    expect(result?.kind).toBe('snippets')
    expect(result?.entries).toHaveLength(1)
    expect(result?.entries[0]?.outcome).toEqual({
      kind: 'draft',
      draft: 'Thank you for writin',
      caret: 20
    })
  })

  it('lists the members for assign, and assigns the one picked', () => {
    const result = menu({ draft: '/assign pe' })

    expect(result?.entries.map(entry => entry.outcome)).toEqual([
      { kind: 'assign', member: { id: 'u1', name: 'Ana Pérez' } }
    ])
  })

  it('names the role of each member as the interface shows it', () => {
    expect(menu({ draft: '/assign pe' })?.entries[0]?.hint).toBe('Agente')
    expect(menu({ draft: '/assign lu' })?.entries[0]?.hint).toBe('Admin')
  })

  it('does not offer for assign someone whose role cannot answer, but still lets a note mention them', () => {
    const members = [
      ...base.members,
      { id: 'u3', name: 'Vera Solo', role: { name: 'Viewer' }, canBeAssigned: false }
    ]
    const assign = menu({ draft: '/assign ', members })
    expect(assign?.entries.map(entry => entry.label)).toEqual(['Ana Pérez', 'Luis'])
    expect(menu({ draft: '/assign vera', members })).toEqual({ kind: 'members', entries: [] })

    const mention = menu({ draft: '@ve', caret: 3, isNote: true, members })
    expect(mention?.entries.map(entry => entry.label)).toContain('Vera Solo')
  })

  it('gives no menu for snippet or assign to who may not use them', () => {
    expect(menu({ draft: '/assign ', commands: [SlashCommand.SNIPPET] })).toBeNull()
    expect(menu({ draft: '/snippet ', commands: [SlashCommand.ASSIGN] })).toBeNull()
  })

  it('offers the teammates after an @ in a note, never the author, and inserts the name', () => {
    const result = menu({ draft: 'ask @', caret: 5, isNote: true })

    expect(result?.kind).toBe('mentions')
    expect(result?.entries.map(entry => entry.id)).toEqual(['u1'])
    expect(result?.entries[0]?.outcome).toEqual({
      kind: 'draft',
      draft: 'ask @Ana Pérez ',
      caret: 15,
      mention: { id: 'u1', name: 'Ana Pérez' }
    })
  })

  it('offers no mention in a reply to the customer, or once the note names as many as it may', () => {
    expect(menu({ draft: 'ask @', caret: 5, isNote: false })).toBeNull()
    expect(menu({ draft: 'ask @', caret: 5, isNote: true, isMentionFull: true })).toBeNull()
  })

  it('closes the mention menu once nobody matches, as after picking a name', () => {
    expect(menu({ draft: 'ask @Ana Pérez ', caret: 15, isNote: true })).toBeNull()
  })

  it('has no menu for plain text', () => {
    expect(menu({ draft: 'hello there', caret: 11, isNote: true })).toBeNull()
  })
})
