import { providerText } from './provider-text'

describe('providerText', () => {
  it('puts the text on one line without control characters', () => {
    expect(providerText('bad\ntoken\u0000\u001b[31m here', 100)).toBe('bad token [31m here')
  })

  it('removes invisible and direction-changing characters', () => {
    expect(providerText('ok\u202Eevil\u200Bhidden', 100)).toBe('ok evil hidden')
  })

  it('keeps the joiners that emoji and several scripts need', () => {
    expect(providerText('👨\u200D👩\u200D👧 می\u200Cخواهم', 100)).toBe(
      '👨\u200D👩\u200D👧 می\u200Cخواهم'
    )
  })

  it('cuts by characters, never in the middle of an emoji', () => {
    expect(providerText('ab😀cd', 3)).toBe('ab😀')
  })
})
