import { pluginActorOf } from '../tenancy/actor'

import { actorIds, actorKeyOf, actorRef } from './orders-actor'

const store = { id: 'store-1' }
const request = { ip: '203.0.113.9', get: () => undefined } as never
const person = { userId: 'user-1', storeId: 'store-1' }
const plugin = pluginActorOf({ id: 'inst-1', pluginId: 'plugin-1' }, store, request)

describe('who an order says did it', () => {
  it('writes a person in the column of the person and a plugin in the column of the plugin, never in both', () => {
    expect(actorIds(person)).toEqual({ userId: 'user-1', pluginId: null })
    expect(actorIds(plugin)).toEqual({ userId: null, pluginId: 'plugin-1' })
  })

  it('never writes the id `plugin:<installation>` of a plugin actor as a user', () => {
    expect(plugin.userId).toBe('plugin:inst-1')
    expect(JSON.stringify(actorIds(plugin))).not.toContain('plugin:inst-1')
  })

  it('refuses a plugin actor that does not say which plugin it is', () => {
    expect(() =>
      actorIds({ userId: 'plugin:inst-1', storeId: 'store-1', pluginInstallationId: 'inst-1' })
    ).toThrow(/id of its plugin/)
  })

  it('tells the events that a plugin is the platform, so that nobody takes its id for a person', () => {
    expect(actorRef(person)).toEqual({ type: 'user', id: 'user-1' })
    expect(actorRef(plugin)).toEqual({ type: 'system', id: null })
  })

  it('names a person and a plugin by different keys, and nobody by null', () => {
    expect(actorKeyOf({ userId: 'user-1', pluginId: null })).toBe('user-1')
    expect(actorKeyOf({ userId: null, pluginId: 'plugin-1' })).toBe('plugin:plugin-1')
    expect(actorKeyOf({ userId: null, pluginId: null })).toBeNull()
    // The same plugin is the same actor: the one that asked cannot approve its own request
    expect(actorKeyOf(actorIds(plugin))).toBe(actorKeyOf({ userId: null, pluginId: 'plugin-1' }))
    expect(actorKeyOf(actorIds(plugin))).not.toBe(actorKeyOf(actorIds(person)))
  })
})
