import { Module } from '@nestjs/common'

import { AuditModule } from '@platform/core/audit-module'
import { BullBoardPlatformModule, HttpPlatformModule } from '@platform/core/http'
import { officialRedactedKeys } from '@platform/plugins/runtime'

import { AnalyticsModule } from './modules/analytics/analytics.module'
import { ApiKeysModule } from './modules/api-keys'
import { AuditLogModule } from './modules/audit-log'
import { AuthModule } from './modules/auth/auth.module'
import { CacheInvalidationModule } from './modules/cache'
import { CarrierGuidesModule } from './modules/carrier-guides/carrier-guides.module'
import { CarriersModule } from './modules/carriers/carriers.module'
import { ChannelRegistryModule } from './modules/channel-registry'
import { ChannelsModule } from './modules/channels/channels.module'
import { ConversationsModule } from './modules/conversations/conversations.module'
import { CountsModule } from './modules/counts/counts.module'
import { CustomersModule } from './modules/customers/customers.module'
import { ExportsModule } from './modules/exports'
import { FinanceModule } from './modules/finance/finance.module'
import { FiscalModule } from './modules/fiscal/fiscal.module'
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
import { PluginWidgetsApiModule } from './modules/plugin-widgets/plugin-widgets.module'
import { PluginsApiModule } from './modules/plugins/plugins.module'
import { ProductsModule } from './modules/products/products.module'
import { PurchasesModule } from './modules/purchases/purchases.module'
import { RealtimeModule } from './modules/realtime/realtime.module'
import { RemittancesModule } from './modules/remittances/remittances.module'
import { ReturnsModule } from './modules/returns/returns.module'
import { RoutingModule } from './modules/routing/routing.module'
import { SearchModule } from './modules/search/search.module'
import { SettingsModule } from './modules/settings/settings.module'
import { ShipmentsModule } from './modules/shipments/shipments.module'
import { TeamModule } from './modules/team/team.module'
import { TenancyModule } from './modules/tenancy'
import { TenantWebhooksModule } from './modules/tenant-webhooks/tenant-webhooks.module'
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
    CacheInvalidationModule,
    BullBoardPlatformModule,
    AuthModule,
    OrganizationsModule,
    TeamModule,
    CustomersModule,
    ConversationsModule,
    MessagesModule,
    MediaModule,
    AuditLogModule,
    ExportsModule,
    NotificationsModule,
    ChannelRegistryModule,
    ChannelsModule,
    CarriersModule,
    CarrierGuidesModule,
    OrderMessagesModule,
    PluginsApiModule,
    PluginWidgetsApiModule,
    MessagingWindowModule,
    RoutingModule,
    RealtimeModule,
    InventoryModule,
    CountsModule,
    OrdersModule,
    ReturnsModule,
    ProductsModule,
    SearchModule,
    TransfersModule,
    WarehousesModule,
    FinanceModule,
    FiscalModule,
    PurchasesModule,
    SettingsModule,
    TenantWebhooksModule,
    ApiKeysModule,
    RemittancesModule,
    ShipmentsModule,
    PickupsModule,
    AnalyticsModule,
    InvitationsModule,
    WebhooksModule,
    WidgetModule
  ]
})
export class AppModule {}
