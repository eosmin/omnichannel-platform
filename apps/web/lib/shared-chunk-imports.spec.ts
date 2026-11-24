import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RETRY_AFTER_METADATA_KEY } from '@platform/core/errors'

// The code every screen shares (the text of an error, the cookie banner) travels in the first load of each route, and the orders screen
// sits 0.1 KB under its lighthouse budget. A barrel that holds values that run code when they load (`@platform/core/auth` has a Symbol
// and functions beside its constants) is kept whole by the bundler as soon as one name of it is read: PR B4 read one key from it and put
// 182 bytes more on the orders screen. These files read what they need from the narrow modules instead.
const SHARED = [
  'error-message.ts',
  'use-error-text.ts',
  join('cookie-consent', 'use-choice-sync.ts')
]
const HEAVY_BARRELS = ['@platform/core/auth', '@platform/core/domain']

const importsOf = (file: string): string[] =>
  [...readFileSync(join(__dirname, file), 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
    match => match[1] ?? ''
  )

describe('the code every screen shares', () => {
  it.each(SHARED)('%s reads no value from a barrel that runs code when it loads', file => {
    const barrels = importsOf(file).filter(source => HEAVY_BARRELS.includes(source))
    expect(barrels).toEqual([])
  })

  it('reads the key of the wait of a 429 from the errors, where it lives', () => {
    expect(RETRY_AFTER_METADATA_KEY).toBe('retryAfterSeconds')
    expect(importsOf('error-message.ts')).toContain('@platform/core/errors')
  })
})
