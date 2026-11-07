import { MessageType } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import {
  acceptWith,
  type ChannelMediaLimit,
  maxFilesOf,
  pickerMaxFiles,
  planAdd
} from './attachment-batch'

const IMAGE: ChannelMediaLimit = {
  type: MessageType.IMAGE,
  maxFiles: 3,
  types: ['image/png', 'image/jpeg'],
  maxBytes: 1000
}
const DOCUMENT: ChannelMediaLimit = {
  type: MessageType.DOCUMENT,
  maxFiles: 2,
  types: ['application/pdf'],
  maxBytes: 5000
}
const media = [IMAGE, DOCUMENT]
const capabilities = ['image', 'document']
const rules = { capabilities, media }
const png = (size = 10) => ({ type: 'image/png', size })

describe('maxFilesOf', () => {
  it('reads the number of the kind, and is one when the directory does not say', () => {
    expect(maxFilesOf(media, MessageType.IMAGE)).toBe(3)
    expect(maxFilesOf(media, MessageType.VIDEO)).toBe(1)
    expect(maxFilesOf(undefined, MessageType.IMAGE)).toBe(1)
    expect(maxFilesOf(media, null)).toBe(1)
  })

  it('gives the picker the largest number of any kind', () => {
    expect(pickerMaxFiles(media)).toBe(3)
    expect(pickerMaxFiles([])).toBe(1)
    expect(pickerMaxFiles(undefined)).toBe(1)
  })
})

describe('planAdd', () => {
  it('takes files up to the number of the kind, in the order they came, and refuses the rest', () => {
    expect(planAdd([], [png(), png(), png(), png()], rules)).toEqual([
      null,
      null,
      null,
      { kind: 'full', max: 3 }
    ])
  })

  it('counts the files already in the message', () => {
    expect(planAdd([MessageType.IMAGE, MessageType.IMAGE], [png(), png()], rules)).toEqual([
      null,
      { kind: 'full', max: 3 }
    ])
  })

  it('does not mix kinds: the first file sets the kind of the message', () => {
    expect(planAdd([], [png(), { type: 'application/pdf', size: 10 }], rules)).toEqual([
      null,
      { kind: 'mixed' }
    ])
    expect(planAdd([MessageType.DOCUMENT], [png()], rules)).toEqual([{ kind: 'mixed' }])
  })

  it('refuses what the platform refuses before what the channel does', () => {
    expect(planAdd([], [{ type: 'application/x-msdownload', size: 5 }, png(0)], rules)).toEqual([
      { kind: 'code', code: ClientErrorCodes.FILE_TYPE_NOT_ALLOWED },
      { kind: 'code', code: ClientErrorCodes.FILE_UPLOAD_FAILED }
    ])
  })

  it('refuses a kind the channel does not declare, a type outside its list and a file too large', () => {
    expect(planAdd([], [{ type: 'video/mp4', size: 10 }], rules)).toEqual([
      { kind: 'code', code: ClientErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED }
    ])
    expect(planAdd([], [{ type: 'image/gif', size: 10 }], rules)).toEqual([
      { kind: 'code', code: ClientErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED }
    ])
    expect(planAdd([], [png(1001)], rules)).toEqual([
      { kind: 'code', code: ClientErrorCodes.CHANNEL_FILE_TOO_LARGE }
    ])
  })

  it('a refused file takes no place: the next one still joins', () => {
    expect(
      planAdd([], [png(1001), png()], { ...rules, media: [{ ...IMAGE, maxFiles: 1 }] })
    ).toEqual([{ kind: 'code', code: ClientErrorCodes.CHANNEL_FILE_TOO_LARGE }, null])
  })

  it('leaves the channel to the api while the directory is unknown, with one file', () => {
    expect(planAdd([], [png(), png()], { capabilities: undefined, media: undefined })).toEqual([
      null,
      { kind: 'full', max: 1 }
    ])
  })

  it('a kind with no list of types takes any allowed type of the kind', () => {
    expect(
      planAdd([], [{ type: 'image/webp', size: 10 }], {
        capabilities,
        media: [{ ...IMAGE, types: null }]
      })
    ).toEqual([null])
  })
})

describe('acceptWith', () => {
  it('offers the types of the lists of the channel and the kinds it declares', () => {
    const accepted = acceptWith(capabilities, media).split(',')
    expect(accepted).toEqual(expect.arrayContaining(['image/png', 'image/jpeg', 'application/pdf']))
    expect(accepted).not.toContain('image/gif')
    expect(accepted).not.toContain('video/mp4')
    expect(accepted).not.toContain('application/msword')
  })

  it('offers every allowed type of a kind that has no list, and offers the kinds by capability while the directory loads', () => {
    expect(acceptWith(['image'], [{ ...IMAGE, types: null }]).split(',')).toContain('image/gif')
    expect(acceptWith(['image'], undefined).split(',')).toContain('image/gif')
    expect(acceptWith([], media)).toBe('')
  })
})
