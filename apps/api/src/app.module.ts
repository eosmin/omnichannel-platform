import { Module } from '@nestjs/common'

import { AuditModule } from '@platform/core/audit-module'
import { BullBoardPlatformModule, HttpPlatformModule } from '@platform/core/http'

import { AuthModule } from './modules/auth/auth.module'
import { ConversationsModule } from './modules/conversations/conversations.module'
import { CustomersModule } from './modules/customers/customers.module'
import { InvitationsModule } from './modules/invitations/invitations.module'
import { OrganizationsModule } from './modules/organizations/organizations.module'
import { SettingsModule } from './modules/settings/settings.module'
import { TeamModule } from './modules/team/team.module'
import { TenancyModule } from './modules/tenancy'
import { WebhooksModule } from './modules/webhooks/webhooks.module'

// TenancyModule comes after HttpPlatformModule: the guards run in the order registered, and the rate
// limit and the token check come first
@Module({
  imports: [
    HttpPlatformModule,
    AuditModule,
    TenancyModule,
    BullBoardPlatformModule,
    AuthModule,
    OrganizationsModule,
    TeamModule,
    CustomersModule,
    ConversationsModule,
    SettingsModule,
    InvitationsModule,
    WebhooksModule
  ]
})
export class AppModule {}
