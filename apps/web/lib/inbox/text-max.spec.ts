import { MessageLimits } from '@platform/core/domain'

import { textMaxOf } from './text-max'

describe('textMaxOf', () => {
  const limits = { textMaxLength: 1000, caption: null }

  it('holds a reply to the limit its plugin declared', () => {
    expect(textMaxOf(limits, false)).toBe(1000)
  })

  it('never goes above what the api takes for any message', () => {
    expect(textMaxOf({ ...limits, textMaxLength: 1_000_000 }, false)).toBe(
      MessageLimits.CONTENT_MAX_LENGTH
    )
  })

  it('leaves a note, which no channel carries, at the general limit', () => {
    expect(textMaxOf(limits, true)).toBe(MessageLimits.CONTENT_MAX_LENGTH)
  })

  it('takes the general limit while the directory has not said', () => {
    expect(textMaxOf(undefined, false)).toBe(MessageLimits.CONTENT_MAX_LENGTH)
    expect(textMaxOf(null, false)).toBe(MessageLimits.CONTENT_MAX_LENGTH)
  })
})
