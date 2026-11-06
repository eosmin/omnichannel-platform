import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ClientPermissions } from '@platform/core/auth'

import { permissionNameKey } from './permission-name'

const messages = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(__dirname, `../messages/${locale}.json`), 'utf8')) as never

function textAt(tree: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      tree
    )
}

// The full-page refusals name the permission that the page needs (QA F2-T13): each of them has a name
// in both languages, or the sentence would show the raw `settings:view`
describe('the name of a permission', () => {
  it('is the path of the team settings text', () => {
    expect(permissionNameKey('settings:view')).toBe('settings.team.permissions.settings.view')
  })

  const APP_DIR = resolve(__dirname, '../app')
  const filesIn = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesIn(path) : path.endsWith('.tsx') ? [path] : []
    })
  // Read from the pages, so that a new gate cannot be added without a name for its permission
  const pageGates = [
    ...new Set(
      filesIn(APP_DIR).flatMap(path =>
        [
          ...readFileSync(path, 'utf8').matchAll(
            /<PermissionDenied\s+permission=\{ClientPermissions\.(\w+)\}/g
          )
        ].map(match => ClientPermissions[match[1] as keyof typeof ClientPermissions])
      )
    )
  ]

  it('finds the gates of the pages', () => {
    expect(pageGates.length).toBeGreaterThanOrEqual(4)
  })

  describe.each(['es', 'en'])('in %s', locale => {
    it.each(pageGates)('exists for %s', permission => {
      const text = textAt(messages(locale), permissionNameKey(permission))
      expect(typeof text).toBe('string')
      expect(String(text).trim()).not.toBe('')
    })
  })
})

// A page that refuses for lack of permission says which one, unless it has a line of its own (the
// exports) or none to name (the settings layout, when no section opens for the person)
describe('the pages that refuse for lack of permission', () => {
  const APP_DIR = resolve(__dirname, '../app')
  const filesIn = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesIn(path) : path.endsWith('.tsx') ? [path] : []
    })

  it('name the permission', () => {
    const bare = filesIn(APP_DIR)
      .filter(path => /<PermissionDenied\s*\/>/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(APP_DIR.length + 1))
    expect(bare).toEqual(['s/store-settings-layout.tsx'])
  })
})
