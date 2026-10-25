import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { TenancyModule } from '../tenancy'

import { InvitationsService } from './invitations.service'
import { MembersService } from './members.service'
import { RolesService } from './roles.service'
import { TeamController } from './team.controller'

// Needs the database and audit modules of the app (and AUTH_SETTINGS, from the token module). TenancyModule exports the context cache that a
// change of a member or a role has to drop.
@Module({
  imports: [TenancyModule, QueuesPlatformModule],
  controllers: [TeamController],
  providers: [MembersService, RolesService, InvitationsService]
})
export class TeamModule {}
