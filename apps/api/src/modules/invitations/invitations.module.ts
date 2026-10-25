import { Module } from '@nestjs/common'

import { AuthModule } from '../auth/auth.module'
import { TenancyModule } from '../tenancy'

import { InvitationsController } from './invitations.controller'
import { InvitationAcceptService } from './invitations.service'

// Needs the database and audit modules of the app. AuthModule exports the SessionService that opens
// the session of a person whose account the accept creates.
@Module({
  imports: [AuthModule, TenancyModule],
  controllers: [InvitationsController],
  providers: [InvitationAcceptService]
})
export class InvitationsModule {}
