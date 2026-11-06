import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ErrorCodes } from '@platform/core/errors'

import { textOfCode, type Translate } from './use-error-text'

const messages = (locale: string): { errors: Record<string, unknown> } =>
  JSON.parse(readFileSync(resolve(__dirname, `../messages/${locale}.json`), 'utf8')) as never

// A translator over a flat list of messages, as far as `textOfCode` reads one
function translatorOf(texts: Record<string, string>): Translate {
  const translate = ((key: string) => texts[key] ?? `[${key}]`) as Translate
  translate.has = key => key in texts
  return translate
}

describe('textOfCode', () => {
  const t = translatorOf({
    'errors.FILE_TOO_LARGE': 'too large',
    'errors.INTERNAL_ERROR': 'something went wrong'
  })

  it('shows the message of a code it has one for', () => {
    expect(textOfCode(t, 'FILE_TOO_LARGE')).toBe('too large')
  })

  it.each(['SOMETHING_NEW', 'timeout', ''])('shows the generic message for %j', code => {
    expect(textOfCode(t, code)).toBe('something went wrong')
  })
})

// The page no longer holds the table of codes: the messages of `errors` are the list of the codes it
// knows. That only holds while `errors` has a text for every code and nothing else (a nested group, or a
// key that is not a code, would be taken for a known code)
describe.each(['es', 'en'])('the `errors` messages in %s', locale => {
  const { errors } = messages(locale)

  it('are one text for each code of the api, and nothing else', () => {
    expect(Object.keys(errors).sort()).toEqual(Object.values(ErrorCodes).sort())
    expect(Object.values(errors).every(value => typeof value === 'string')).toBe(true)
  })
})
