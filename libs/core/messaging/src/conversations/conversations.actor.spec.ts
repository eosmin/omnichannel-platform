import { Permissions } from '@platform/core/auth'
import { ActorKinds, PLUGIN_ACTOR_PREFIX } from '@platform/core/domain'

import { pluginViewerOf } from '../messages/plugin-message-origin'

import { actorOfViewer, viewerOf } from './conversations.support'

const held = [Permissions.CONVERSATIONS_VIEW]

describe('actorOfViewer', () => {
  it('is the person for the viewer of a person', () => {
    expect(actorOfViewer(viewerOf('user-1', held))).toEqual({
      kind: ActorKinds.PERSON,
      userId: 'user-1'
    })
  })

  it('is the plugin for the viewer of a plugin, whatever the user id says', () => {
    expect(actorOfViewer(pluginViewerOf(held, 'plugin-1'))).toEqual({
      kind: ActorKinds.PLUGIN,
      pluginId: 'plugin-1'
    })
  })

  it.each([
    ['no user id and no plugin', pluginViewerOf(held)],
    [
      'the id of a call made for a plugin that did not say which',
      viewerOf(`${PLUGIN_ACTOR_PREFIX}abc`, held)
    ]
  ])('refuses %s: nothing is written under an empty or a false author', (_name, viewer) => {
    expect(() => actorOfViewer(viewer)).toThrow('cannot be the author of a change')
  })
})
