import { snippetParts } from './snippet'

describe('snippetParts', () => {
  it('flags the matched words and keeps the text around them', () => {
    expect(snippetParts('quiero <mark>camisa</mark> azul')).toEqual([
      { text: 'quiero ', isMatch: false },
      { text: 'camisa', isMatch: true },
      { text: ' azul', isMatch: false }
    ])
  })

  it('reads several matches', () => {
    expect(snippetParts('<mark>a</mark> y <mark>b</mark>').map(part => part.isMatch)).toEqual([
      true,
      false,
      true
    ])
  })

  it('leaves any other markup as the text it is', () => {
    expect(snippetParts('<img src=x onerror=1> <mark>hola</mark>')).toEqual([
      { text: '<img src=x onerror=1> ', isMatch: false },
      { text: 'hola', isMatch: true }
    ])
  })

  it('drops a mark that was never closed instead of matching the rest', () => {
    expect(snippetParts('antes <mark>sin cierre')).toEqual([
      { text: 'antes sin cierre', isMatch: false }
    ])
  })

  it('drops a closing mark that opens nothing', () => {
    expect(snippetParts('solo </mark> texto')).toEqual([{ text: 'solo  texto', isMatch: false }])
  })

  it('does not nest: a mark inside a match is dropped', () => {
    expect(snippetParts('<mark>uno <mark>dos</mark>')).toEqual([{ text: 'uno dos', isMatch: true }])
  })

  it('is empty for an empty snippet', () => {
    expect(snippetParts('')).toEqual([])
  })
})
