import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { findWideDeletes } from './shared-table-cleanup'

const ROOT = join(__dirname, '..', '..')
const SKIPPED = new Set(['node_modules', 'generated', 'dist', '.nx', '.next', 'coverage', '.git'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (SKIPPED.has(name)) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith('.ts') && !path.endsWith('shared-table-cleanup.spec.ts') ? [path] : []
  })
}

// What the suites that share the database run: the specs, their helpers and the end-to-end support
const isSuiteCode = (path: string): boolean =>
  /\.spec\.ts$/.test(path) ||
  /\/src\/testing\//.test(path) ||
  /\/tests\/(helpers|builders)\//.test(path) ||
  /\/web-e2e\/support\//.test(path)

describe('cleanup of the suites over the shared database', () => {
  it('flags the filters that reach what a suite did not make', () => {
    const wide = [
      `DELETE FROM media WHERE key LIKE $1`,
      `DELETE FROM media WHERE purpose = 'avatar'`,
      `DELETE FROM media WHERE status = 'pending'`,
      'DELETE FROM notifications',
      `DELETE FROM audit_logs WHERE resource_type = 'media'`,
      'DELETE FROM media WHERE id IS NOT NULL',
      'owner.notification.deleteMany()',
      'owner.notification.deleteMany({})',
      'owner.notification.deleteMany({ where: {} })'
    ]
    for (const text of wide) expect(findWideDeletes(text)).toHaveLength(1)
  })

  it('lets pass what is deleted by id, owner, store or the prefix of the run', () => {
    const own = [
      'DELETE FROM media WHERE id = ANY($1)',
      'DELETE FROM media WHERE id = ANY(${ids})',
      'DELETE FROM media WHERE id IN ($1, $2)',
      'DELETE FROM media WHERE uploaded_by = ANY($1)',
      'DELETE FROM users WHERE email LIKE $1',
      'DELETE FROM organizations WHERE slug LIKE $1',
      'DELETE FROM audit_logs WHERE resource_type = $1',
      'owner.notification.deleteMany({ where: { storeId } })'
    ]
    for (const text of own) expect(findWideDeletes(text)).toEqual([])
  })

  it('finds none in the suites of the repository', () => {
    const offenders = files(ROOT)
      .filter(isSuiteCode)
      .flatMap(path =>
        findWideDeletes(readFileSync(path, 'utf8')).map(
          found => `${relative(ROOT, path)}:${found.line} ${found.text} (${found.reason})`
        )
      )
    expect(offenders).toEqual([])
  })
})
