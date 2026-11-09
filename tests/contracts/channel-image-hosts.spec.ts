import { InstagramPlugin } from '@platform/channels/instagram'
import { MessengerPlugin } from '@platform/channels/messenger'
import { isImageHostOrigin } from '@platform/core/domain'

import {
  CUSTOMER_AVATAR_IMAGE_HOSTS,
  STORY_REPLY_IMAGE_HOSTS
} from '../../apps/web/lib/security-headers'

// The plugins now declare the hosts the browser may load their pictures from; the CSP of the web app is built
// from that (Step 7.9 B2). Until then the web keeps its own lists, and this is the lock between the two: what
// the plugins declare is exactly what the CSP allows today, so changing one without the other fails here.
const plugins = [new InstagramPlugin({} as never), new MessengerPlugin({} as never)]

const [instagram, messenger] = plugins

describe('the image hosts the official plugins declare', () => {
  it('are the ones each plugin always had, plugin by plugin', () => {
    expect(instagram?.imageHosts).toEqual({
      avatar: ['https://*.fbcdn.net', 'https://*.cdninstagram.com'],
      media: ['https://lookaside.fbsbx.com']
    })
    expect(messenger?.imageHosts).toEqual({
      avatar: ['https://*.fbcdn.net', 'https://platform-lookaside.fbsbx.com'],
      media: []
    })
  })

  it('are the avatar hosts of the CSP today, no more and no fewer', () => {
    const declared = new Set(plugins.flatMap(plugin => [...plugin.imageHosts.avatar]))
    expect(declared).toEqual(new Set(CUSTOMER_AVATAR_IMAGE_HOSTS))
  })

  it('are the media hosts of the CSP today, no more and no fewer', () => {
    const declared = new Set(plugins.flatMap(plugin => [...plugin.imageHosts.media]))
    expect(declared).toEqual(new Set(STORY_REPLY_IMAGE_HOSTS))
  })

  it('are all hosts the registry would accept', () => {
    for (const plugin of plugins) {
      for (const host of [...plugin.imageHosts.avatar, ...plugin.imageHosts.media]) {
        expect(isImageHostOrigin(host, { wildcard: true })).toBe(true)
      }
    }
  })
})
