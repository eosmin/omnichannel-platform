import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { Permissions, PermissionsOfUnbuiltAreas, ReservedPermissions } from '@platform/core/auth'

// A permission nobody reads is a promise the interface can show and the server never keeps: a role
// can hold it and nothing changes (QA, P.02 and P.05). Every permission of a resource that is built
// has to be read by the code, or be listed in `ReservedPermissions` with the step that reads it.
const REPO = resolve(__dirname, '../../../../..')
// The server: what the interface shows is not a permission that is kept (QA, P.02 and P.05)
const ROOTS = ['apps/api/src', 'apps/worker/src', 'libs'].map(name => join(REPO, name))
const SKIPPED = new Set(['node_modules', 'generated', 'dist', '.next', '.nx'])
// The catalog itself and the map of plugin scopes name every permission without reading any
const NOT_A_READER = new Set([
  join(REPO, 'libs/core/domain/auth/permissions.ts'),
  join(REPO, 'libs/plugins/sdk/src/plugin-scopes.ts')
])
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/.*$/gm

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return SKIPPED.has(name) ? [] : sources(path)
    const isSource = /\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name)
    return isSource && !NOT_A_READER.has(path) ? [path] : []
  })
}

describe('the permissions of the catalog', () => {
  const code = ROOTS.flatMap(sources)
    .map(file => readFileSync(file, 'utf8').replace(COMMENTS, ''))
    .join('\n')
  const isRead = (key: string): boolean =>
    new RegExp(String.raw`\bPermissions\.${key}\b`).test(code)
  const builtArea = ([, value]: [string, string]): boolean =>
    !PermissionsOfUnbuiltAreas.some(prefix => value.startsWith(prefix))

  it('reads the code it scans, so that an empty scan cannot pass', () => {
    expect(isRead('CONVERSATIONS_VIEW')).toBe(true)
    expect(isRead('NO_SUCH_PERMISSION')).toBe(false)
  })

  it('does not count the interface, nor a comment, as a reader', () => {
    expect('// Permissions.NOBODY_READS_ME\nconst a = 1'.replace(COMMENTS, '')).not.toContain(
      'NOBODY'
    )
  })

  it('leaves no permission of a built resource that nobody reads and nobody reserved', () => {
    const orphans = Object.entries(Permissions)
      .filter(builtArea)
      .filter(([key, value]) => !isRead(key) && ReservedPermissions[value] === undefined)
      .map(([, value]) => value)

    expect(orphans).toEqual([])
  })

  it('reserves only permissions that exist, that nobody reads yet, and says which step reads them', () => {
    const values: string[] = Object.values(Permissions)
    for (const [permission, step] of Object.entries(ReservedPermissions)) {
      expect(values).toContain(permission)
      expect(step).toMatch(/^Step \d+\.\d+: /)
      const key = Object.entries(Permissions).find(([, value]) => value === permission)?.[0]
      // A reservation that is read already is stale: drop it from the list
      expect(isRead(key ?? '')).toBe(false)
    }
  })
})
