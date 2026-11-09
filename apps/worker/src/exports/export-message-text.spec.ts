import { exportMessageText } from './export-message-text'

const file = (position: number | null, caption: string | null) => ({ position, caption })

describe('exportMessageText', () => {
  it('writes the text of a message once when the first file only holds a copy of it', () => {
    expect(
      exportMessageText({ content: 'hello', textApart: false, media: [file(0, 'hello')] })
    ).toBe('hello')
    // An edit left the copy stale: the replaced text is not written
    expect(
      exportMessageText({ content: 'edited', textApart: false, media: [file(0, 'old')] })
    ).toBe('edited')
  })

  it('adds the text under the files after the first', () => {
    expect(
      exportMessageText({
        content: 'one',
        textApart: false,
        media: [file(0, 'one'), file(1, 'two'), file(2, null)]
      })
    ).toBe('one\ntwo')
  })

  it('writes the own text of every file, the first included, then the text of the message that went apart', () => {
    expect(
      exportMessageText({
        content: 'for all',
        textApart: true,
        media: [file(0, 'one'), file(1, 'two')]
      })
    ).toBe('for all\none\ntwo')
  })

  it('keeps a message with no text empty', () => {
    expect(
      exportMessageText({ content: null, textApart: false, media: [file(0, null)] })
    ).toBeNull()
  })
})
