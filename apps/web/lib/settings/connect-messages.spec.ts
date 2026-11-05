import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { ChannelHealthErrors } from '@platform/core/domain'
import { ChannelConnectFailureReasons } from '@platform/core/errors'

const messages = (
  locale: string
): { settings: { channels: Record<string, Record<string, unknown>> } } =>
  JSON.parse(readFileSync(resolve(__dirname, `../../messages/${locale}.json`), 'utf8')) as never

// A reason or a health error without text would draw a raw key on the screen exactly when something fails
describe.each(['en', 'es'])('the texts of a failed connection in %s', locale => {
  const { channels } = messages(locale).settings

  it.each(Object.values(ChannelConnectFailureReasons))('has a text for the reason %s', reason => {
    const text = (channels['connectFailure'] ?? {})[reason]
    expect(typeof text).toBe('string')
    expect(String(text).trim()).not.toBe('')
  })

  it('has no text for a reason that does not exist (nothing left over)', () => {
    expect(Object.keys(channels['connectFailure'] ?? {}).sort()).toEqual(
      Object.values(ChannelConnectFailureReasons).sort()
    )
  })

  it.each(Object.values(ChannelHealthErrors))('has a text for the health error %s', error => {
    const text = ((channels['health'] ?? {})['errors'] as Record<string, unknown> | undefined)?.[
      error
    ]
    expect(typeof text).toBe('string')
    expect(String(text).trim()).not.toBe('')
  })

  it('has the texts of the dialog that updates a token', () => {
    const texts: Record<string, unknown> = channels['updateToken'] ?? {}
    for (const key of ['action', 'title', 'description', 'submit', 'submitting', 'done']) {
      expect(typeof texts[key]).toBe('string')
      expect((texts[key] as string).trim()).not.toBe('')
    }
  })
})

// The owner chose "expira" for what a token does, and no jargon: "caduca"/"vence", "webhook" and
// "enlazada" (the Spanish says "vinculada") must not come back into what a person reads when a connection fails
describe('the vocabulary of the failed connection texts in Spanish', () => {
  const { channels } = messages('es').settings
  const texts = [
    ...Object.values(channels['connectFailure'] ?? {}),
    ...Object.values(((channels['health'] ?? {})['errors'] ?? {}) as Record<string, unknown>),
    ...Object.values(channels['updateToken'] ?? {})
  ].map(String)

  it('has texts to check', () => {
    expect(texts.length).toBeGreaterThan(10)
  })

  it.each([/caduc/i, /venc/i, /webhook/i, /enlazad/i])('never uses %s', pattern => {
    expect(texts.filter(text => pattern.test(text))).toEqual([])
  })
})
