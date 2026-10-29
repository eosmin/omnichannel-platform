import { Controller, Get } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { NoStore } from '@platform/core/http'

import { CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { PresenceService, type UserPresence } from './presence.service'

// The team widget of the inbox needs the presence of the store before any socket event arrives
@Controller()
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @NoStore()
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.presence.team)
  team(@CurrentStore() store: ResolvedTenant['store']): Promise<UserPresence[]> {
    return this.presence.getStorePresence(store.id)
  }
}
