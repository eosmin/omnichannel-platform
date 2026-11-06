import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const filesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '.next' ? [] : filesIn(path)
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [path] : []
  })

// The full table of permissions is one binding for the bundler (see `ClientPermissions`). Only the roles
// screen needs all of them, to draw the matrix of a role; everything else reads `ClientPermissions`.
const MAY_READ_THE_FULL_TABLE = ['apps/web/lib/settings/permission-groups.ts']

describe('the permissions in the browser', () => {
  const root = resolve(__dirname, '../../..')
  const sources = [
    ...filesIn(resolve(__dirname, '..')),
    ...filesIn(resolve(__dirname, '../../../libs/api-client/src'))
  ]

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('reads the full table only where the roles screen needs it', () => {
    const offenders = sources
      .filter(path => /(?<![A-Za-z-])Permissions\b(?!-)/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(root.length + 1))
      .filter(path => !MAY_READ_THE_FULL_TABLE.includes(path))
    expect(offenders).toEqual([])
  })
})
