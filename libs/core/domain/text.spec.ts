import { plainText } from './text'

describe('plainText', () => {
  it('lowers the case and takes the accents off', () => {
    expect(plainText('ENVÍO Rápido')).toBe('envio rapido')
    expect(plainText('envio')).toBe(plainText('Envío'))
  })

  it('reads a precomposed letter and a decomposed one as the same', () => {
    expect(plainText('é')).toBe(plainText('é'))
  })

  it('takes out the invisible characters that split a word', () => {
    for (const invisible of ['​', '⁠', '­', '﻿', '‍', '‮', 'ㅤ']) {
      expect(plainText(`re${invisible}fund`)).toBe('refund')
    }
  })

  it('leaves nothing of a text made of accents and invisible characters', () => {
    expect(plainText('́')).toBe('')
    expect(plainText('​́')).toBe('')
    expect(plainText('ㅤ')).toBe('')
  })

  it('reads every run of blanks as one space, so a phrase is found across lines', () => {
    expect(plainText('where is my\norder')).toBe('where is my order')
    expect(plainText('where  is\tmy order')).toBe('where is my order')
  })

  it('keeps the marks that change a word in other scripts', () => {
    // ba (voiced) and ha (unvoiced) of the kana are two words
    expect(plainText('ばか')).not.toBe(plainText('はか'))
  })

  it('keeps the rest as it is', () => {
    expect(plainText('¿cuánto? 2x1!')).toBe('¿cuanto? 2x1!')
  })
})
