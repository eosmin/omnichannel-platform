import { InstagramPlugin } from '@platform/channels/instagram'
import { MessengerPlugin } from '@platform/channels/messenger'
import { isImageHostOrigin, MetaStoryImageHosts } from '@platform/core/domain'
import { renderImageHostsFile, unionOfImageHosts } from '@platform/plugins/runtime'

import {
  PLUGIN_AVATAR_IMAGE_HOSTS,
  PLUGIN_MEDIA_IMAGE_HOSTS
} from '../../apps/web/lib/generated/plugin-image-hosts'

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

  it('are all hosts the registry would accept', () => {
    for (const plugin of plugins) {
      for (const host of [...plugin.imageHosts.avatar, ...plugin.imageHosts.media]) {
        expect(isImageHostOrigin(host, { wildcard: true })).toBe(true)
      }
    }
  })
})

describe('the CSP hosts generated from the plugins (Step 7.9 B2)', () => {
  it('are what the official plugins declare, no more and no fewer, each host once, in registration order', () => {
    expect(PLUGIN_AVATAR_IMAGE_HOSTS).toEqual(unionOfImageHosts(plugins, { wildcard: true }).avatar)
    expect(PLUGIN_MEDIA_IMAGE_HOSTS).toEqual(unionOfImageHosts(plugins, { wildcard: true }).media)
  })

  it('make a file that differs as soon as one declared host changes, so a stale or hand-edited file is caught', () => {
    const now = renderImageHostsFile(unionOfImageHosts(plugins, { wildcard: true }))
    const changed = renderImageHostsFile(
      unionOfImageHosts(
        [...plugins, { imageHosts: { avatar: ['https://img.acme.test'], media: [] } }],
        {
          wildcard: true
        }
      )
    )
    expect(changed).not.toBe(now)
    expect(now).toContain('PLUGIN_AVATAR_IMAGE_HOSTS: readonly string[] = [')
    expect(renderImageHostsFile(unionOfImageHosts(plugins, { wildcard: true }))).toBe(now)
  })

  it('draws the story thumbnails from exactly the hosts the Instagram plugin keeps story links by', () => {
    expect(instagram?.imageHosts.media).toEqual(MetaStoryImageHosts.map(host => `https://${host}`))
  })

  it('include the exact hosts of a plugin of a third party, with no change to the web app', () => {
    const toy = {
      imageHosts: { avatar: ['https://img.acme.test'], media: ['https://m.acme.test'] }
    }
    const union = unionOfImageHosts([...plugins, toy], { wildcard: true })
    expect(union.avatar).toContain('https://img.acme.test')
    expect(union.media).toContain('https://m.acme.test')
  })

  it('refuse a wildcard unless the plugin is an official one, as the registry does', () => {
    const wild = { imageHosts: { avatar: ['https://*.acme.test'], media: [] } }
    expect(() => unionOfImageHosts([wild])).toThrow()
    expect(unionOfImageHosts([wild], { wildcard: true }).avatar).toEqual(['https://*.acme.test'])
  })

  it('refuse a host that is not an exact https origin, so a plugin cannot widen the policy', () => {
    for (const bad of [
      '*',
      'https://*',
      'http://x.test',
      'https://x.test/path',
      'https://u@x.test'
    ]) {
      expect(() =>
        unionOfImageHosts([{ imageHosts: { avatar: [bad], media: [] } }], { wildcard: true })
      ).toThrow()
    }
  })
})
