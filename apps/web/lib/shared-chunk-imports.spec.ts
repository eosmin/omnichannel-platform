import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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

// What the shell and the orders screen read from the shared libraries travels with them in the first load, whole: a file of a library
// is kept entire as soon as one name of it is read, and a table built at the top of the file from the names of another (a key written as
// `[Types.NAME]:`, a value read as `Permissions.NAME`) is kept with it even when nobody reads the table. So the tables that only the
// server or one screen reads live in files of their own, and the files below must not bring them back.
const DOMAIN = join(__dirname, '..', '..', '..', 'libs', 'core', 'domain')

const sourcesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourcesIn(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })

// The table of permissions of the server (and its presets) is read only by these: the roles screen, the keys of the api and the
// exports, none of which is part of the first load of the shell
const MAY_READ_THE_TABLE_OF_PERMISSIONS = new Set([
  'api-key-constants.ts',
  join('exports', 'export-permissions.ts'),
  'order-notice-permissions.ts'
])

describe('the constants of the domain that every screen reads', () => {
  it('read no value from the table of permissions of the server, except the files made for it', () => {
    // Named from the file itself, from the folder (`./auth`, `./auth/index`) or taken whole (`import * as`, `export ... from`)
    const reaches =
      /(?:import|export)\s*(?:\{[^}]*\b(?:Permissions|RolePresets|PermissionRequires)\b[^}]*\}|\*(?:\s+as\s+\w+)?)\s*from\s*'[^']*\/auth(?:\/index|\/permissions)?'/
    const offenders = sourcesIn(DOMAIN)
      .map(file => relative(DOMAIN, file))
      .filter(file => !file.startsWith('auth') && !MAY_READ_THE_TABLE_OF_PERMISSIONS.has(file))
      .filter(file => reaches.test(readFileSync(join(DOMAIN, file), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('keep the delivery matrix of the notifications apart from the names every screen reads', () => {
    const names = readFileSync(join(DOMAIN, 'notifications', 'notification-constants.ts'), 'utf8')
    for (const moved of [
      'NotificationDefaults',
      'NotificationGroups',
      'NotificationGroupTypes',
      'NotificationLockedTypes',
      'NotificationTypesWithoutEmitter'
    ]) {
      expect(names).not.toMatch(new RegExp(`export const ${moved}\\b`))
    }
  })
})
