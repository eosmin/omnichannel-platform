import { Locales } from '@platform/core/i18n'

import { labelTextsFor } from './label-texts'

const word = expect.stringMatching(/\S/) as unknown

describe('labelTextsFor', () => {
  it('has every word of the label in each language the platform supports', () => {
    for (const locale of [Locales.EN, Locales.ES]) {
      expect(labelTextsFor(locale)).toEqual({
        from: word,
        to: word,
        collect: word,
        paid: word,
        order: word,
        packages: word,
        service: word,
        notes: word
      })
    }
  })

  it('writes the words in the language of the store', () => {
    expect(labelTextsFor(Locales.ES).to).not.toBe(labelTextsFor(Locales.EN).to)
  })
})
