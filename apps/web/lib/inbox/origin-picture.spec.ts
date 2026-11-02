import type { ConversationOriginView } from '@platform/api-client'
import { MediaStatus } from '@platform/core/domain'

import { pictureFileOf } from './origin-picture'

function origin(patch: Partial<ConversationOriginView>): ConversationOriginView {
  return {
    id: 'o1',
    messageId: 'm1',
    kind: 'ad',
    sourceId: null,
    sourceUrl: null,
    title: null,
    body: null,
    mediaType: null,
    mediaUrl: null,
    thumbnailUrl: null,
    mediaFile: null,
    thumbnailFile: null,
    createdAt: '2026-11-04T09:59:00.000Z',
    ...patch
  }
}

describe('pictureFileOf', () => {
  it('prefers the thumbnail', () => {
    const thumb = { id: 't', status: MediaStatus.CLEAN }
    const media = { id: 'm', status: MediaStatus.CLEAN }
    expect(
      pictureFileOf(origin({ thumbnailFile: thumb, mediaFile: media, mediaType: 'image' }))
    ).toBe(thumb)
  })

  it('uses the media of an image', () => {
    const media = { id: 'm', status: MediaStatus.CLEAN }
    expect(pictureFileOf(origin({ mediaFile: media, mediaType: 'image' }))).toBe(media)
  })

  it('draws nothing from a video file and nothing from the address of the ad', () => {
    const media = { id: 'm', status: MediaStatus.CLEAN }
    expect(pictureFileOf(origin({ mediaFile: media, mediaType: 'video' }))).toBeNull()
    expect(pictureFileOf(origin({ thumbnailUrl: 'https://cdn.example.com/a.jpg' }))).toBeNull()
  })
})
