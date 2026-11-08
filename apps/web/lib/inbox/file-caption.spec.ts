import { asksBeforeResending, fileCaptionOf, mayResendFileCaption } from './file-caption'

const file = (overrides: Partial<Parameters<typeof fileCaptionOf>[0]> = {}) => ({
  position: 1,
  caption: 'Second',
  captionState: null,
  ...overrides
})

describe('fileCaptionOf', () => {
  it('draws the text under a file that is not the first', () => {
    expect(fileCaptionOf(file())).toEqual({ text: 'Second', state: null })
  })

  it('leaves the first file to the text of the message', () => {
    expect(fileCaptionOf(file({ position: 0 }))).toBeNull()
  })

  it('draws nothing for a file of the customer or a blank text', () => {
    expect(fileCaptionOf(file({ position: null }))).toBeNull()
    expect(fileCaptionOf(file({ caption: '  ' }))).toBeNull()
    expect(fileCaptionOf(file({ caption: null }))).toBeNull()
  })

  it('keeps the state of a text that did not clearly go, even with no text to show', () => {
    expect(fileCaptionOf(file({ captionState: 'failed' }))).toEqual({
      text: 'Second',
      state: 'failed'
    })
    expect(fileCaptionOf(file({ caption: null, captionState: 'unconfirmed' }))).toEqual({
      text: null,
      state: 'unconfirmed'
    })
  })

  it('reads a state it does not know, or one that went, as none', () => {
    expect(fileCaptionOf(file({ captionState: 'sent' }))).toEqual({
      text: 'Second',
      state: null
    })
    expect(fileCaptionOf(file({ captionState: 'from-the-future' }))?.state).toBeNull()
  })
})

describe('resending the text under a file', () => {
  it('is offered for a text that failed or may not have gone, not for one on its way or none', () => {
    expect(mayResendFileCaption('failed', 'sent')).toBe(true)
    expect(mayResendFileCaption('unconfirmed', 'delivered')).toBe(true)
    expect(mayResendFileCaption('queued', 'sent')).toBe(false)
    expect(mayResendFileCaption(null, 'sent')).toBe(false)
  })

  it('needs the file itself to have gone: a text without its file is not what the agent meant', () => {
    for (const delivery of ['failed', 'queued', null]) {
      expect(mayResendFileCaption('failed', delivery)).toBe(false)
    }
    expect(mayResendFileCaption('unconfirmed', 'read')).toBe(true)
  })

  it('asks first only when the customer may already have it', () => {
    expect(asksBeforeResending('unconfirmed')).toBe(true)
    expect(asksBeforeResending('failed')).toBe(false)
    expect(asksBeforeResending('queued')).toBe(false)
    expect(asksBeforeResending(null)).toBe(false)
  })
})
