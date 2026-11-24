import type { MessageView } from '@platform/api-client'
import { MediaStatus, MessageType } from '@platform/core/domain'

import { isRunImage } from './image-runs'
import { isViewableFile, viewableFilesOf } from './viewable-file'
import { viewerItemsOf } from './viewer-items'

type File = MessageView['media'][number]

const shown: File = {
  id: 'f1',
  filename: 'a.png',
  contentType: 'image/png',
  fileSize: 10,
  status: MediaStatus.CLEAN,
  position: null,
  delivery: null,
  errorCode: null,
  caption: null,
  targetable: false
}
const hidden: File = { ...shown, id: 'f2', filename: null, contentType: null, fileSize: null }

describe('a file with no name, type or size (BAN-R-meta)', () => {
  it('is not viewable, and the others are', () => {
    expect(isViewableFile(shown)).toBe(true)
    expect(isViewableFile(hidden)).toBe(false)
    expect(viewableFilesOf([shown, hidden]).map(file => file.id)).toEqual(['f1'])
  })

  it('is never a picture the viewer walks', () => {
    expect(viewerItemsOf([shown, hidden], MessageType.IMAGE).map(item => item.mediaId)).toEqual([
      'f1'
    ])
  })

  it('never joins a run of pictures', () => {
    const message = {
      id: 'm1',
      type: MessageType.IMAGE,
      authorType: 'customer',
      media: [hidden],
      content: null,
      sticker: false,
      unavailableFiles: [],
      replyToMessageId: null,
      attachmentUrl: null,
      storyReply: null,
      location: null,
      contacts: null,
      unsupportedType: null,
      deletedAt: null,
      system: null,
      orderSummary: null
    } as unknown as MessageView
    expect(isRunImage(message)).toBe(false)
  })
})
