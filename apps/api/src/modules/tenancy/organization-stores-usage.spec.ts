import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// apps/api/src and the libraries: the mark is searched everywhere the api could take a controller from
const ROOT = join(__dirname, '../../../../..')
const SCANNED = ['apps/api/src', 'libs'].map(dir => join(ROOT, dir))
const MARK = '@TenantOfOrganizationStores('
// The metadata can also be set by hand (SetMetadata with the key): the key is searched for as well
const KEY = 'TENANT_ORGANIZATION_STORES_KEY'
// Where the key is declared and where the interceptor reads it
const OWN = [
  'apps/api/src/modules/tenancy/decorators.ts',
  'apps/api/src/modules/tenancy/tenant-context.interceptor.ts'
]

// The files that may widen the context of a request to every store of the organization. It is a widening of tenancy: Row-Level Security
// no longer separates sibling stores there, so who sees and moves what rests on the service alone. Adding a file to this list is a decision
// the reviewers of tenancy take, not a side effect of writing a reason. A plugin route must never be here: a key is bound to ONE store.
const ALLOWED_ON_CLASS = [
  'apps/api/src/modules/counts/counts.controller.ts',
  'apps/api/src/modules/purchases/purchase-orders.controller.ts',
  'apps/api/src/modules/transfers/transfers.controller.ts',
  'apps/api/src/modules/warehouses/warehouses.controller.ts'
]
// The one route that stands on a METHOD: the delete of a plugin of the organization, which has to see the installations of every store
// (a person's route behind SETTINGS_MANAGE_PLUGINS; the service reads and removes only rows of that plugin, of the organization of the guard)
const ALLOWED_ON_METHOD = {
  file: 'apps/api/src/modules/plugins/plugins.controller.ts',
  method: 'remove'
}
const ALLOWED = [...ALLOWED_ON_CLASS, ALLOWED_ON_METHOD.file].sort()

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
  it('is used by exactly the controllers of transfers, counts, warehouses and purchase orders, and by the delete of a plugin, and by no plugin-api route', () => {
    const users = SCANNED.flatMap(sources)
      .filter(path => {
        const text = readFileSync(path, 'utf8')
        return text.includes(MARK) || text.includes(KEY)
      })
      .map(path => relative(ROOT, path))
      // The decorator itself is declared in the tenancy module
      .filter(path => !OWN.includes(path))
      .sort()

    expect(users).toEqual(ALLOWED)
  })

  it('stands on the class, so that no route of those controllers is left in the context of one store', () => {
    for (const file of ALLOWED_ON_CLASS) {
      const text = readFileSync(join(ROOT, file), 'utf8')
      const at = text.indexOf(MARK)
      const classAt = text.indexOf('@Controller(')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(classAt)
    }
  })

  it('stands on the method remove alone in the controller of the plugins, and on no other route of it', () => {
    const text = readFileSync(join(ROOT, ALLOWED_ON_METHOD.file), 'utf8')
    expect(text.split(MARK)).toHaveLength(2)
    const at = text.indexOf(MARK)
    // The decorator belongs to the handler that follows it: `remove`, with no other handler between them
    const after = text.slice(at)
    expect(after.indexOf(`async ${ALLOWED_ON_METHOD.method}(`)).toBeGreaterThan(-1)
    expect(after.slice(0, after.indexOf(`async ${ALLOWED_ON_METHOD.method}(`))).not.toMatch(
      /@(Get|Post|Put|Patch)\(/
    )
    const between = after.slice(0, after.indexOf(`async ${ALLOWED_ON_METHOD.method}(`))
    // Exactly one handler decorator, and no other method, between the mark and `remove`
    expect(between.split('@Delete(')).toHaveLength(2)
    expect(between).not.toMatch(/\basync \w+\(/)
    expect(text.indexOf(MARK)).toBeGreaterThan(text.indexOf('@Controller('))
  })

  it('has no plugin route in those controllers: a key is bound to one store and must never see the lines of a sibling', () => {
    for (const file of ALLOWED) {
      expect(readFileSync(join(ROOT, file), 'utf8')).not.toContain('@PluginApi(')
    }
  })
})
