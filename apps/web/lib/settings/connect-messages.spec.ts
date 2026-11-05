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
})
