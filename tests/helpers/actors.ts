import type { INestApplication } from '@nestjs/common'

import type { Permission } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'

import { createRole } from '../builders'

import { createActor } from './context'
import type { Actor } from './http'

// A member of a store whose role holds exactly the permissions given: the way to prove that a route
// asks for one permission and not for another that a preset would bring along
export async function actorWithPermissions(
  owner: OwnerClient,
  app: INestApplication,
  input: {
    prefix: string
    name: string
    organizationId: string
    storeId: string
    permissions: readonly Permission[]
  }
): Promise<Actor> {
  const role = await createRole(owner, {
    storeId: input.storeId,
    name: `${input.prefix}-${input.name}`,
    permissions: input.permissions
  })
  return createActor(owner, app, {
    prefix: input.prefix,
    name: input.name,
    organizationId: input.organizationId,
    storeId: input.storeId,
    roleId: role.id
  })
}
