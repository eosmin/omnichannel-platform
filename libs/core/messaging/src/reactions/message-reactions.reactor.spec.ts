import { AuthorType } from '@platform/core/domain'

import { reactionWhereOf, reactorOfJob } from './message-reactions.service'

describe('the reactor of a reaction job', () => {
  it('is the person of a job that names a user', () => {
    expect(reactorOfJob({ userId: 'user-1' })).toEqual({
      authorType: AuthorType.AGENT,
      userId: 'user-1'
    })
  })

  it('is the plugin of a job that names one, even beside a null user', () => {
    expect(reactorOfJob({ userId: null, pluginId: 'plugin-1' })).toEqual({
      authorType: AuthorType.SYSTEM,
      pluginId: 'plugin-1'
    })
  })

  it('refuses a job that names nobody', () => {
    expect(() => reactorOfJob({ userId: null })).toThrow('neither a person nor a plugin')
  })

  it('finds the row of a person by user and of a plugin by plugin, never by the other column', () => {
    expect(reactionWhereOf({ authorType: AuthorType.AGENT, userId: 'user-1' })).toEqual({
      authorType: AuthorType.AGENT,
      customerIdentityId: null,
      userId: 'user-1',
      pluginId: null
    })
    expect(reactionWhereOf({ authorType: AuthorType.SYSTEM, pluginId: 'plugin-1' })).toEqual({
      authorType: AuthorType.SYSTEM,
      customerIdentityId: null,
      userId: null,
      pluginId: 'plugin-1'
    })
  })
})
