import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const MODULES = join(__dirname, '..')
const MARK = '@TenantOfOrganizationStores('

// The files that may widen the context of a request to every store of the organization. It is a widening of tenancy: Row-Level Security
// no longer separates sibling stores there, so who sees and moves what rests on the service alone. Adding a file to this list is a decision
// the reviewers of tenancy take, not a side effect of writing a reason. A plugin route must never be here: a key is bound to ONE store.
const ALLOWED = [
  'counts/counts.controller.ts',
  'transfers/transfers.controller.ts',
  'warehouses/warehouses.controller.ts'
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

describe('@TenantOfOrganizationStores', () => {
  it('is used by exactly the controllers of transfers, counts and warehouses, and by no plugin route', () => {
    const users = sources(MODULES)
      .filter(path => readFileSync(path, 'utf8').includes(MARK))
      .map(path => relative(MODULES, path))
      // The decorator itself is declared in the tenancy module
      .filter(path => path !== 'tenancy/decorators.ts')
      .sort()

    expect(users).toEqual(ALLOWED)
  })

  it('stands on the class, so that no route of those controllers is left in the context of one store', () => {
    for (const file of ALLOWED) {
      const text = readFileSync(join(MODULES, file), 'utf8')
      const at = text.indexOf(MARK)
      const classAt = text.indexOf('export class ')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(classAt)
    }
  })
})
