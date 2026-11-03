import type { INestApplication } from '@nestjs/common'

import { RoleNames } from '@platform/core/auth'
import { type OwnerClient, ensureMembership } from '@platform/core/database-testing'
import { MembershipStatus } from '@platform/core/domain'

import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// What the code that is not an endpoint does with a membership that is suspended
describe('A suspended membership, outside the api', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it('is left suspended, with its role, when the bootstrap of the owner runs again', async () => {
    const member = await createActor(owner, app, {
      prefix,
      name: 'suspendedBootstrap',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
    await owner.membership.updateMany({
      where: { userId: member.id, storeId: ctx.storeA.id },
      data: { status: MembershipStatus.SUSPENDED }
    })

    // The bootstrap runs at every start: it must not undo what a person decided
    await ensureMembership(owner, {
      userId: member.id,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })

    const row = await owner.membership.findFirstOrThrow({
      where: { userId: member.id, storeId: ctx.storeA.id }
    })
    expect(row).toMatchObject({
      status: MembershipStatus.SUSPENDED,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
  })
})
