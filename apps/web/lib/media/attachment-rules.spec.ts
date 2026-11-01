import {
  attachmentMessageType,
  formatBytes,
  refusalCode,
  refuseAttachment
} from './attachment-rules'

describe('refuseAttachment', () => {
  it('lets an allowed type that fits', () => {
    expect(refuseAttachment({ type: 'image/png', size: 1000 })).toBeNull()
  })

  it('refuses an empty file, a type that is not allowed and a file that is too large', () => {
    expect(refuseAttachment({ type: 'image/png', size: 0 })).toBe('empty')
    expect(refuseAttachment({ type: '', size: 10 })).toBe('type_not_allowed')
    expect(refuseAttachment({ type: 'application/x-msdownload', size: 10 })).toBe(
      'type_not_allowed'
    )
    expect(refuseAttachment({ type: 'image/png', size: 11 * 1024 * 1024 })).toBe('too_large')
  })

  it('gives a video the larger limit', () => {
    expect(refuseAttachment({ type: 'video/mp4', size: 20 * 1024 * 1024 })).toBeNull()
    expect(refuseAttachment({ type: 'video/mp4', size: 26 * 1024 * 1024 })).toBe('too_large')
  })
})

describe('attachmentMessageType', () => {
  it('names the message type of a file', () => {
    expect(attachmentMessageType('application/pdf')).toBe('DOCUMENT')
    expect(attachmentMessageType('audio/ogg')).toBe('AUDIO')
    expect(attachmentMessageType('text/html')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('writes the size with one unit', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatBytes(1048575)).toBe('1.0 MB')
  })
})

describe('refusalCode', () => {
  it('maps each refusal to the code the api uses', () => {
    expect(refusalCode('type_not_allowed')).toBe('FILE_TYPE_NOT_ALLOWED')
    expect(refusalCode('too_large')).toBe('FILE_TOO_LARGE')
    expect(refusalCode('empty')).toBe('FILE_UPLOAD_FAILED')
  })
})
