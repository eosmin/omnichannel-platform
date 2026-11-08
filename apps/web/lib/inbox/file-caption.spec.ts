import { fileCaptionOf } from './file-caption'

const file = (overrides: Partial<Parameters<typeof fileCaptionOf>[0]> = {}) => ({
  position: 1,
  caption: 'Second',
  captionState: null,
  ...overrides
})

describe('fileCaptionOf', () => {
  it('draws the text under a file that is not the first', () => {
    expect(fileCaptionOf(file(), 1)).toEqual({ text: 'Second', state: null })
  })

  it('leaves the first file to the text of the message', () => {
    expect(fileCaptionOf(file({ position: 0 }), 0)).toBeNull()
  })

  it('draws nothing for a file of the customer or a blank text', () => {
    expect(fileCaptionOf(file({ position: null }), 1)).toBeNull()
    expect(fileCaptionOf(file({ caption: '  ' }), 1)).toBeNull()
    expect(fileCaptionOf(file({ caption: null }), 1)).toBeNull()
  })

  it('keeps the state of a text that did not clearly go, even with no text to show', () => {
    expect(fileCaptionOf(file({ captionState: 'failed' }), 1)).toEqual({
      text: 'Second',
      state: 'failed'
    })
    expect(fileCaptionOf(file({ caption: null, captionState: 'unconfirmed' }), 2)).toEqual({
      text: null,
      state: 'unconfirmed'
    })
  })

  it('reads a state it does not know, or one that went, as none', () => {
    expect(fileCaptionOf(file({ captionState: 'sent' }), 1)).toEqual({
      text: 'Second',
      state: null
    })
    expect(fileCaptionOf(file({ captionState: 'from-the-future' }), 1)?.state).toBeNull()
  })
})
