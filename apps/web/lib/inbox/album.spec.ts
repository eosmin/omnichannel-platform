import { DeliveryStatus, MessageType } from '@platform/core/domain'

import { fileDeliveryOf, isAlbum, sayRetryOnlyFailed } from './album'

const image = { contentType: 'image/png', delivery: null }
const video = { contentType: 'video/mp4', delivery: null }

describe('isAlbum', () => {
  it('draws several pictures as a grid', () => {
    expect(isAlbum([image, image], MessageType.IMAGE, false)).toBe(true)
    expect(isAlbum([image, image, image], MessageType.IMAGE, false)).toBe(true)
  })

  it('leaves a lone picture, a sticker, and files that are not pictures in the list', () => {
    expect(isAlbum([image], MessageType.IMAGE, false)).toBe(false)
    expect(isAlbum([image, image], MessageType.IMAGE, true)).toBe(false)
    expect(isAlbum([video, video], MessageType.VIDEO, false)).toBe(false)
    expect(isAlbum([image, video], MessageType.IMAGE, false)).toBe(false)
    expect(isAlbum([], MessageType.IMAGE, false)).toBe(false)
  })

  it('does not take the voice notes that are mp4 for pictures', () => {
    expect(isAlbum([video, video], MessageType.AUDIO, false)).toBe(false)
  })
})

describe('fileDeliveryOf', () => {
  it('tells a file that waits and a file that failed, and nothing of the rest', () => {
    expect(fileDeliveryOf({ delivery: DeliveryStatus.QUEUED })).toBe('queued')
    expect(fileDeliveryOf({ delivery: DeliveryStatus.FAILED })).toBe('failed')
    expect(fileDeliveryOf({ delivery: DeliveryStatus.SENT })).toBeNull()
    expect(fileDeliveryOf({ delivery: DeliveryStatus.READ })).toBeNull()
    expect(fileDeliveryOf({ delivery: null })).toBeNull()
    expect(fileDeliveryOf({ delivery: 'a state of a newer server' })).toBeNull()
  })
})

describe('sayRetryOnlyFailed', () => {
  const failed = { delivery: DeliveryStatus.FAILED }
  const sent = { delivery: DeliveryStatus.SENT }

  it('says it when some failed and some went out', () => {
    expect(sayRetryOnlyFailed([sent, failed, sent])).toBe(true)
  })

  it('is silent when all failed, none failed, or there is no state per file', () => {
    expect(sayRetryOnlyFailed([failed, failed])).toBe(false)
    expect(sayRetryOnlyFailed([sent, sent])).toBe(false)
    expect(sayRetryOnlyFailed([{ delivery: null }, { delivery: null }])).toBe(false)
  })
})
