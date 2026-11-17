import {
  deleterPluginOf,
  editorPluginOf,
  isOnBehalfOfPerson,
  pluginAuthorshipOf,
  sameAuthorship
} from './plugin-author'

describe('pluginAuthorshipOf', () => {
  it('is none for a message no plugin wrote, and for one from an older server', () => {
    expect(
      pluginAuthorshipOf({ authorType: 'agent', authorPluginId: null, authorNickname: null })
    ).toBeNull()
    expect(pluginAuthorshipOf({ authorType: 'agent' })).toBeNull()
    expect(
      pluginAuthorshipOf({ authorType: 'system', authorPluginId: '', authorNickname: 'x' })
    ).toBeNull()
  })

  it('says a plugin that writes as the system is automatic and keeps its nickname', () => {
    expect(
      pluginAuthorshipOf({
        authorType: 'system',
        authorPluginId: 'acme-bot',
        authorNickname: 'Bot'
      })
    ).toEqual({ pluginId: 'acme-bot', nickname: 'Bot', automatic: true })
  })

  it('treats a nickname of only spaces as none', () => {
    expect(
      pluginAuthorshipOf({ authorType: 'system', authorPluginId: 'a', authorNickname: '   ' })
    ).toMatchObject({ nickname: null })
  })

  it('draws the mark "on behalf of" only for a plugin that wrote as a person, never for the system with no nickname', () => {
    const asPerson = pluginAuthorshipOf({
      authorType: 'agent',
      authorPluginId: 'acme-bot',
      authorNickname: null
    })
    const asSystem = pluginAuthorshipOf({
      authorType: 'system',
      authorPluginId: 'acme-bot',
      authorNickname: '   '
    })
    expect(asPerson !== null && isOnBehalfOfPerson(asPerson)).toBe(true)
    expect(asSystem !== null && isOnBehalfOfPerson(asSystem)).toBe(false)
  })

  it('says a plugin that writes for a person is not automatic', () => {
    expect(
      pluginAuthorshipOf({ authorType: 'agent', authorPluginId: 'acme-bot', authorNickname: '' })
    ).toEqual({ pluginId: 'acme-bot', nickname: null, automatic: false })
  })
})

describe('editorPluginOf and deleterPluginOf', () => {
  it('name the plugin, and nothing for a person, the channel or an older server', () => {
    expect(editorPluginOf({ editedByPluginId: 'acme-bot' })).toBe('acme-bot')
    expect(editorPluginOf({ editedByPluginId: null })).toBeNull()
    expect(editorPluginOf({})).toBeNull()
    expect(deleterPluginOf({ deletedByPluginId: 'acme-bot' })).toBe('acme-bot')
    expect(deleterPluginOf({ deletedByPluginId: '' })).toBeNull()
    expect(deleterPluginOf({})).toBeNull()
  })
})

describe('sameAuthorship', () => {
  it('compares the plugin and the nickname, treating absent as none', () => {
    expect(sameAuthorship({}, { authorPluginId: null, authorNickname: null })).toBe(true)
    expect(
      sameAuthorship(
        { authorPluginId: 'a', authorNickname: 'x' },
        { authorPluginId: 'a', authorNickname: 'x' }
      )
    ).toBe(true)
    expect(
      sameAuthorship(
        { authorPluginId: 'a', authorNickname: 'x' },
        { authorPluginId: 'a', authorNickname: 'y' }
      )
    ).toBe(false)
    expect(sameAuthorship({ authorPluginId: 'a' }, {})).toBe(false)
    // No plugin: a nickname does not split
    expect(sameAuthorship({ authorNickname: 'x' }, { authorNickname: 'y' })).toBe(true)
  })
})
