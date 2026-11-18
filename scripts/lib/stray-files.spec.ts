import { findStrayFiles, strayFileSuffix } from './stray-files'

describe('strayFileSuffix', () => {
  it.each([
    ['docs/IMPLEMENTATION_PLAN.md-e', '-e'],
    ['libs/core/x.ts-e', '-e'],
    ['package.json-e', '-e'],
    ['migrations/1/migration.sql-e', '-e'],
    ['backup.bak/a.ts', '.bak'],
    ['apps/x.orig/deep/file.ts', '.orig'],
    ['libs/core/a.ts.orig', '.orig'],
    ['libs/core/a.ts.rej', '.rej'],
    ['notes.bak', '.bak'],
    ['docs/plan.md~', '~']
  ])('flags %s', (file, suffix) => {
    expect(strayFileSuffix(file)).toBe(suffix)
  })

  it.each([
    'docs/IMPLEMENTATION_PLAN.md',
    'libs/core/original.ts',
    'apps/web/app/~tilde/page.tsx',
    'scripts/lib/stray-files.ts',
    'docs/backup-plan.md',
    'apps/web/app/some-e/page.tsx',
    'docs/the-end.md'
  ])('lets %s pass', file => {
    expect(strayFileSuffix(file)).toBeNull()
  })
})

describe('findStrayFiles', () => {
  it('returns only the leftovers, with the suffix that gave them away', () => {
    expect(findStrayFiles(['a.ts', 'docs/x.md-e', 'b.ts.orig'])).toEqual([
      { file: 'docs/x.md-e', suffix: '-e' },
      { file: 'b.ts.orig', suffix: '.orig' }
    ])
  })

  it('returns nothing for a clean tree', () => {
    expect(findStrayFiles(['a.ts', 'docs/x.md'])).toEqual([])
  })
})
