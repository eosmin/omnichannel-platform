import type { ConversationOriginView } from '@platform/api-client'
import { MediaStatus } from '@platform/core/domain'

import { originsNeedRefresh, pictureFileOf } from './origin-picture'

const NOW = Date.parse('2026-11-04T10:00:00.000Z')

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

describe('originsNeedRefresh', () => {
  const pending = { id: 't', status: MediaStatus.PENDING }

  it('asks again while a recent picture is pending', () => {
    expect(originsNeedRefresh([origin({ thumbnailFile: pending })], NOW)).toBe(true)
  })

  it('asks again while a recent origin has a link and the worker has stored no file yet', () => {
    expect(
      originsNeedRefresh([origin({ thumbnailUrl: 'https://cdn.example.com/a.jpg' })], NOW)
    ).toBe(true)
    expect(
      originsNeedRefresh(
        [origin({ mediaType: 'video', mediaUrl: 'https://cdn.example.com/a.mp4' })],
        NOW
      )
    ).toBe(false)
  })

  it('stops when the picture is clean, missing, or the origin is old', () => {
    expect(
      originsNeedRefresh([origin({ thumbnailFile: { id: 't', status: MediaStatus.CLEAN } })], NOW)
    ).toBe(false)
    expect(originsNeedRefresh([origin({})], NOW)).toBe(false)
    expect(originsNeedRefresh(undefined, NOW)).toBe(false)
    expect(
      originsNeedRefresh(
        [origin({ thumbnailFile: pending, createdAt: '2026-11-04T09:00:00.000Z' })],
        NOW
      )
    ).toBe(false)
  })
})
