import { type ChannelLimitsView, MessageType } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import {
  captionsOf,
  requireCaptionFits,
  requireCaptionsPlaced,
  requireTextFits
} from './caption-rules'

// What the plugins declare: the spec holds the rules, not the numbers of any channel in particular
const WITH_CAPTION_RULE: ChannelLimitsView = {
  textMaxLength: 4096,
  caption: { maxLength: 1024, withoutCaption: [MessageType.AUDIO] }
}
const SHORT_TEXT: ChannelLimitsView = { textMaxLength: 1000, caption: null }
const LONG_TEXT: ChannelLimitsView = { textMaxLength: 2000, caption: null }

const codeOf = (work: () => void): unknown => {
  try {
    work()
  } catch (error) {
    return error instanceof PlatformException ? error.code : error
  }
  return null
}

describe('requireCaptionFits', () => {
  it('accepts no text, and text within the limit', () => {
    expect(() => requireCaptionFits(WITH_CAPTION_RULE, MessageType.IMAGE, undefined)).not.toThrow()
    expect(() =>
      requireCaptionFits(WITH_CAPTION_RULE, MessageType.IMAGE, 'a'.repeat(1024))
    ).not.toThrow()
  })

  it('refuses a caption over the limit its plugin declared (1024 here), counted as characters', () => {
    expect(() =>
      requireCaptionFits(WITH_CAPTION_RULE, MessageType.DOCUMENT, 'a'.repeat(1025))
    ).toThrow()
    expect(() =>
      requireCaptionFits(WITH_CAPTION_RULE, MessageType.IMAGE, '😀'.repeat(1024))
    ).not.toThrow()
  })

  it('refuses text under a kind of file the plugin declares without caption', () => {
    expect(codeOf(() => requireCaptionFits(WITH_CAPTION_RULE, MessageType.AUDIO, 'hola'))).toBe(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
    )
  })

  it('holds a channel with no caption rule to the limit of its text', () => {
    expect(() => requireCaptionFits(SHORT_TEXT, MessageType.IMAGE, 'a'.repeat(1001))).toThrow()
    expect(() => requireCaptionFits(LONG_TEXT, MessageType.IMAGE, 'a'.repeat(2001))).toThrow()
    expect(() => requireCaptionFits(LONG_TEXT, MessageType.AUDIO, 'a'.repeat(2000))).not.toThrow()
  })

  it('does not bound a channel the registry does not know', () => {
    expect(() => requireCaptionFits(null, MessageType.IMAGE, 'a'.repeat(5000))).not.toThrow()
  })
})

describe('captionsOf', () => {
  const ids = ['a', 'b', 'c']

  it('puts the text of the message under the first file where the text goes with the file', () => {
    expect(captionsOf({ mediaIds: ids, content: 'One' }, false)).toEqual(['One', null, null])
    // `captions` wins for the places it names; the text of the message is the first one's where it does not reach
    expect(captionsOf({ mediaIds: ids, content: 'One', captions: [] }, false)).toEqual([
      'One',
      null,
      null
    ])
    expect(captionsOf({ mediaIds: ids, content: 'One', captions: ['Own', 'Two'] }, false)).toEqual([
      'Own',
      'Two',
      null
    ])
  })

  it('keeps the text of the message apart where it goes after the files: each file has only its own', () => {
    expect(captionsOf({ mediaIds: ids, content: 'General' }, true)).toEqual([null, null, null])
    expect(
      captionsOf({ mediaIds: ids, content: 'General', captions: ['One', null, 'Three'] }, true)
    ).toEqual(['One', null, 'Three'])
  })
})

describe('requireCaptionsPlaced with the text apart', () => {
  const body = { mediaIds: ['a', 'b'], captions: ['One', 'Two'] }

  it('takes a text under every file, the first included, where the channel carries one under each', () => {
    expect(() => requireCaptionsPlaced(body, true, true)).not.toThrow()
  })

  it('refuses a text under the first file too where the kind has no place for one', () => {
    expect(codeOf(() => requireCaptionsPlaced({ ...body, captions: ['One'] }, false, true))).toBe(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
    )
  })

  it('still refuses more texts than files', () => {
    expect(() =>
      requireCaptionsPlaced({ ...body, captions: ['a', 'b', 'c'] }, true, true)
    ).toThrow()
  })
})

describe('requireTextFits', () => {
  it('holds the text of the message to the limit of a plain text of its channel', () => {
    expect(() => requireTextFits(WITH_CAPTION_RULE, undefined)).not.toThrow()
    expect(() => requireTextFits(WITH_CAPTION_RULE, 'a'.repeat(4096))).not.toThrow()
    expect(() => requireTextFits(WITH_CAPTION_RULE, 'a'.repeat(4097))).toThrow()
    expect(() => requireTextFits(null, 'a'.repeat(9000))).not.toThrow()
  })
})
