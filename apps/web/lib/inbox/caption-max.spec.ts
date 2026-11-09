import { captionMaxOf } from './caption-max'

describe('captionMaxOf', () => {
  it('takes the caption rule of the plugin where it has one', () => {
    expect(captionMaxOf({ textMaxLength: 4096, caption: { maxLength: 1024 } })).toBe(1024)
  })

  it('falls back to the limit of the text', () => {
    expect(captionMaxOf({ textMaxLength: 1000, caption: null })).toBe(1000)
  })

  it('says nothing while the directory has not said', () => {
    expect(captionMaxOf(undefined)).toBeUndefined()
    expect(captionMaxOf(null)).toBeUndefined()
  })
})
