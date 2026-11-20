import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// apps/api/src and the libraries: the mark is searched everywhere the api could take a controller from
const ROOT = join(__dirname, '../../../../..')
const SCANNED = ['apps/api/src', 'libs'].map(dir => join(ROOT, dir))
const MARK = '@TenantOfOrganizationStores('

// The files that may widen the context of a request to every store of the organization. It is a widening of tenancy: Row-Level Security
// no longer separates sibling stores there, so who sees and moves what rests on the service alone. Adding a file to this list is a decision
// the reviewers of tenancy take, not a side effect of writing a reason. A plugin route must never be here: a key is bound to ONE store.
const ALLOWED = [
  'apps/api/src/modules/counts/counts.controller.ts',
  'apps/api/src/modules/transfers/transfers.controller.ts',
  'apps/api/src/modules/warehouses/warehouses.controller.ts'
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'generated' ? [] : sources(path)
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('@TenantOfOrganizationStores', () => {
  it('is used by exactly the controllers of transfers, counts and warehouses, and by no plugin route', () => {
    const users = SCANNED.flatMap(sources)
      .filter(path => readFileSync(path, 'utf8').includes(MARK))
      .map(path => relative(ROOT, path))
      // The decorator itself is declared in the tenancy module
      .filter(path => path !== 'apps/api/src/modules/tenancy/decorators.ts')
      .sort()

    expect(users).toEqual(ALLOWED)
  })

  it('stands on the class, so that no route of those controllers is left in the context of one store', () => {
    for (const file of ALLOWED) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      const at = text.indexOf(MARK)
      const classAt = text.indexOf('@Controller(')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(classAt)
    }
  })
})
