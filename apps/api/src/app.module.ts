import { Module } from '@nestjs/common'

import { AuditModule } from '@platform/core/audit-module'
import { BullBoardPlatformModule, HttpPlatformModule } from '@platform/core/http'
import { officialRedactedKeys } from '@platform/plugins/runtime'

import { AuthModule } from './modules/auth/auth.module'
import { CarriersModule } from './modules/carriers/carriers.module'
import { ChannelRegistryModule } from './modules/channel-registry'
import { ChannelsModule } from './modules/channels/channels.module'
import { ConversationsModule } from './modules/conversations/conversations.module'
import { CountsModule } from './modules/counts/counts.module'
import { CustomersModule } from './modules/customers/customers.module'
import { ExportsModule } from './modules/exports'
import { InventoryModule } from './modules/inventory/inventory.module'
import { InvitationsModule } from './modules/invitations/invitations.module'
import { MediaModule } from './modules/media/media.module'
import { MessagesModule } from './modules/messages/messages.module'
import { MessagingWindowModule } from './modules/messaging-window/messaging-window.module'
import { NotificationsModule } from './modules/notifications'
import { OrderMessagesModule } from './modules/order-messages'
import { OrdersModule } from './modules/orders/orders.module'
import { OrganizationsModule } from './modules/organizations/organizations.module'
import { PickupsModule } from './modules/pickups/pickups.module'
import { PluginsApiModule } from './modules/plugins/plugins.module'
import { ProductsModule } from './modules/products/products.module'
import { RealtimeModule } from './modules/realtime/realtime.module'
import { RemittancesModule } from './modules/remittances/remittances.module'
import { ReturnsModule } from './modules/returns/returns.module'
import { RoutingModule } from './modules/routing/routing.module'
import { SettingsModule } from './modules/settings/settings.module'
import { ShipmentsModule } from './modules/shipments/shipments.module'
import { TeamModule } from './modules/team/team.module'
import { TenancyModule } from './modules/tenancy'
import { TransfersModule } from './modules/transfers/transfers.module'
import { WarehousesModule } from './modules/warehouses/warehouses.module'
import { WebhooksModule } from './modules/webhooks/webhooks.module'
import { WidgetModule } from './modules/widget/widget.module'

// TenancyModule comes after HttpPlatformModule: the guards run in the order registered, and the rate
// limit and the token check come first
@Module({
  imports: [
    HttpPlatformModule.forRoot({ redactedKeys: officialRedactedKeys() }),
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
    NotificationsModule,
    ChannelRegistryModule,
    ChannelsModule,
    CarriersModule,
    OrderMessagesModule,
    PluginsApiModule,
    MessagingWindowModule,
    RoutingModule,
    RealtimeModule,
    InventoryModule,
    CountsModule,
    OrdersModule,
    ReturnsModule,
    ProductsModule,
    TransfersModule,
    WarehousesModule,
    SettingsModule,
    RemittancesModule,
    ShipmentsModule,
    PickupsModule,
    InvitationsModule,
    WebhooksModule,
    WidgetModule
  ]
})
export class AppModule {}
