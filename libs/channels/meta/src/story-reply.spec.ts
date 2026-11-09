import { MessageMetadataKeys, MetaStoryImageHosts } from '@platform/core/domain'

import { storyImageUrlOf, storyReplyMetadata } from './story-reply'

describe('the link of a story', () => {
  it.each(MetaStoryImageHosts)('keeps an https link on the allowed host %s', host => {
    const url = `https://${host}/ig_messaging_cdn/?asset_id=1&signature=x`
    expect(storyImageUrlOf(url)).toBe(url)
  })

  it.each([
    ['plain http', 'http://lookaside.fbsbx.com/a.jpg'],
    ['another host', 'https://example.com/a.jpg'],
    ['a subdomain of the allowed host', 'https://evil.lookaside.fbsbx.com/a.jpg'],
    ['a host that only ends like it', 'https://notlookaside.fbsbx.com/a.jpg'],
    ['the allowed host inside another', 'https://lookaside.fbsbx.com.evil.com/a.jpg'],
    ['the allowed host in the path', 'https://evil.com/lookaside.fbsbx.com/a.jpg'],
    ['the allowed host as credentials', 'https://lookaside.fbsbx.com@evil.com/a.jpg'],
    ['credentials on the allowed host', 'https://user:pass@lookaside.fbsbx.com/a.jpg'],
    ['a port', 'https://lookaside.fbsbx.com:8443/a.jpg'],
    ['another fbsbx host', 'https://apps.fbsbx.com/a.jpg'],
    ['a data link', 'data:image/png;base64,AAAA'],
    ['a javascript link', 'javascript:alert(1)'],
    ['text that is no link', 'not a link']
  ])('drops %s', (_name, url) => {
    expect(storyImageUrlOf(url)).toBeUndefined()
  })

  it('matches the host whatever its case', () => {
    expect(storyImageUrlOf('https://LOOKASIDE.fbsbx.com/a.jpg')).toBe(
      'https://LOOKASIDE.fbsbx.com/a.jpg'
    )
  })
})

describe('the metadata of a reply to a story', () => {
  const key = MessageMetadataKeys.STORY_REPLY

  it('is nothing when the message answered no story', () => {
    expect(storyReplyMetadata(undefined)).toEqual({})
  })

  it('keeps the link that may be drawn', () => {
    expect(storyReplyMetadata({ url: 'https://lookaside.fbsbx.com/a.jpg' })).toEqual({
      [key]: { url: 'https://lookaside.fbsbx.com/a.jpg' }
    })
  })

  it.each([undefined, 'https://example.com/a.jpg', 'http://lookaside.fbsbx.com/a.jpg'])(
    'still says it was a story reply, with no link, when the link is %s',
    url => {
      expect(storyReplyMetadata({ url })).toEqual({ [key]: {} })
    }
  )
})
