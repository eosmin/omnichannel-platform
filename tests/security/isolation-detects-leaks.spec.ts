import type { INestApplication } from '@nestjs/common'

import type { OwnerClient } from '@platform/core/database-testing'

import { ProbeRoutes } from '../../apps/api/src/testing/tenant-probe.controller'
import { createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import {
  type IsolationCheck,
  isolationChecks,
  type IsolationResource,
  type IsolationScene
} from '../helpers/isolation'

// A gate that has never failed proves nothing. These routes of the probe forget the store on purpose
// (a service written without thinking about tenants), and the checks of tenant-isolation.spec.ts
// have to catch each way they leak. If a check is weakened until it lets one through, this file
// is what turns red.
// Each resource renames to a name of its own: tags are unique by name in a store, and two routes
// renaming to the same name would fail on that, not on the check that is being tested
function renamingTo(name: string): Pick<IsolationResource, 'untouched'> {
  return {
    untouched: async (owner, id) =>
      (await owner.tag.findUnique({ where: { id }, select: { name: true } }))?.name !== name
  }
}

const leaky: IsolationResource = {
  name: 'leakyTag',
  create: createTag,
  readPath: ProbeRoutes.leakyTagById,
  modify: { path: ProbeRoutes.leakyTagById, body: { name: 'hacked-leaky' } },
  ...renamingTo('hacked-leaky')
}

describe('the isolation checks', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let scene: IsolationScene

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    scene = { app, owner, ctx }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it.each(['claimingOwnStore', 'siblingStore', 'modification'] satisfies IsolationCheck[])(
    'fail the check %s on a route that forgets the store',
    async check => {
      await expect(isolationChecks[check](scene, leaky)).rejects.toThrow()
    }
  )

  it('fail the check modification on a route that answers 404 but has already changed the row', async () => {
    // The status is the right one, so only the look at the row can catch it
    const lateCheck: IsolationResource = {
      ...leaky,
      name: 'lateCheckTag',
      modify: { path: ProbeRoutes.lateCheckTagById, body: { name: 'hacked-late' } },
      ...renamingTo('hacked-late')
    }

    await expect(isolationChecks.modification(scene, lateCheck)).rejects.toThrow()
  })

  it('still pass the check of the other organization on it, because the guard refuses first', async () => {
    // The first layer (TenantGuard) protects even a route whose service forgot the store; the
    // others are what the service itself has to keep
    await expect(isolationChecks.otherOrganization(scene, leaky)).resolves.toBeUndefined()
  })
})
