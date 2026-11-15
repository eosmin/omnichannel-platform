import { actorColumnsOf, ActorKinds } from './actor-identity'
import { AuthorType } from './status-enums'

describe('actorColumnsOf', () => {
  it('names a person by their id and by no plugin', () => {
    expect(actorColumnsOf({ kind: ActorKinds.PERSON, userId: 'user-1' })).toEqual({
      type: AuthorType.AGENT,
      id: 'user-1',
      pluginId: null
    })
  })

  it('names a plugin as the system, by its id and by no person', () => {
    expect(actorColumnsOf({ kind: ActorKinds.PLUGIN, pluginId: 'plugin-1' })).toEqual({
      type: AuthorType.SYSTEM,
      id: null,
      pluginId: 'plugin-1'
    })
  })

  it('names the platform by neither', () => {
    expect(actorColumnsOf({ kind: ActorKinds.SYSTEM })).toEqual({
      type: AuthorType.SYSTEM,
      id: null,
      pluginId: null
    })
  })
})
