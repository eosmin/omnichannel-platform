import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The reconciliation of the fiscal documents reads the sales and returns of every store the person reaches. The request of a store holds
// that store alone with Row-Level Security on, so the route opens no transaction of its own (`@NoTenantTransaction`) and the service reads
// in the unit of the organization. Read from the source, as the spec of the reports of the books does: importing the controller would load
// the environment.
const controller = readFileSync(join(__dirname, 'fiscal.controller.ts'), 'utf8')

describe('GET fiscal reconciliation', () => {
  it('is @NoTenantTransaction, and reads the reach of the person in a unit of its own', () => {
    const at = controller.indexOf('async reconciliation(')
    expect(at).toBeGreaterThan(-1)
    const decorators = controller.slice(controller.lastIndexOf('  @RequirePermissions(', at), at)
    expect(decorators).toContain('@NoTenantTransaction(')
    expect(controller.slice(at, at + 600)).toContain('this.reach.storesInUnit(')
  })

  it('has the service read each page in a strict unit of the organization', () => {
    const service = readFileSync(
      join(__dirname, '../../../../../libs/fiscal/runtime/src/fiscal-sweep.service.ts'),
      'utf8'
    )
    expect(service).toMatch(/jobContext\.inOrganization\(\s*organizationId,/)
    expect(service).not.toContain('inOrganizationOrRequest')
  })
})
