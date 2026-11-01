import { Module } from '@nestjs/common'

import { AuditModule } from '@platform/core/audit-module'
import { BullBoardPlatformModule, HttpPlatformModule } from '@platform/core/http'

import { AuthModule } from './modules/auth/auth.module'
import { ChannelRegistryModule } from './modules/channel-registry'
import { ChannelsModule } from './modules/channels/channels.module'
import { ConversationsModule } from './modules/conversations/conversations.module'
import { CustomersModule } from './modules/customers/customers.module'
import { ExportsModule } from './modules/exports'
import { InvitationsModule } from './modules/invitations/invitations.module'
import { MediaModule } from './modules/media/media.module'
import { MessagesModule } from './modules/messages/messages.module'
import { MessagingWindowModule } from './modules/messaging-window/messaging-window.module'
import { OrganizationsModule } from './modules/organizations/organizations.module'
import { PluginsApiModule } from './modules/plugins/plugins.module'
import { RealtimeModule } from './modules/realtime/realtime.module'
import { RoutingModule } from './modules/routing/routing.module'
import { SettingsModule } from './modules/settings/settings.module'
import { TeamModule } from './modules/team/team.module'
import { TenancyModule } from './modules/tenancy'
import { WebhooksModule } from './modules/webhooks/webhooks.module'
import { WidgetModule } from './modules/widget/widget.module'

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
    MessagesModule,
    MediaModule,
    ExportsModule,
    ChannelRegistryModule,
    ChannelsModule,
    PluginsApiModule,
    MessagingWindowModule,
    RoutingModule,
    RealtimeModule,
    SettingsModule,
    InvitationsModule,
    WebhooksModule,
    WidgetModule
  ]
})
export class AppModule {}
