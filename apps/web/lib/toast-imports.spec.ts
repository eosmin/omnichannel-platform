import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const filesIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name === '.next' ? [] : filesIn(path)
    return /\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name) ? [path] : []
  })

// `sonner` is fetched when the first toast is asked for (see `lib/toast.ts`): the pages ask through
// `lib/toast`, and only the Toaster and the bridge to it import the library
const MAY_IMPORT_SONNER = [
  'apps/web/components/ui/sonner.tsx',
  'apps/web/components/ui/toaster-loaded.tsx',
  'apps/web/lib/toast.ts'
]

describe('sonner in the browser', () => {
  const root = resolve(__dirname, '../../..')
  const sources = filesIn(resolve(__dirname, '..'))

  it('has sources to check', () => {
    expect(sources.length).toBeGreaterThan(100)
  })

  it('is imported only by the files that load it with the first toast', () => {
    const offenders = sources
      .filter(path => /['"]sonner['"]/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(root.length + 1))
      .filter(path => !MAY_IMPORT_SONNER.includes(path))
    expect(offenders).toEqual([])
  })
})
