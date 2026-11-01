import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common'

import { WebWidgetPlatformModule } from '@platform/channels/web-widget'
import { ApiRoutes } from '@platform/core/api'

import { ChannelRegistryModule } from '../channel-registry'
import { ChannelsModule } from '../channels/channels.module'
import { TenancyModule } from '../tenancy'

import { WidgetAway } from './widget-away.service'
import { WidgetCorsMiddleware } from './widget-cors.middleware'
import { WidgetCustomerTyping } from './widget-customer-typing.service'
import { WidgetDeliveryListener } from './widget-delivery.listener'
import { WidgetDeliveryModule } from './widget-delivery.module'
import { WidgetHistory } from './widget-history.service'
import { WidgetSettingsController } from './widget-settings.controller'
import { WidgetSettings } from './widget-settings.service'
import { WidgetSites } from './widget-sites.service'
import { WidgetTokens } from './widget-tokens.service'
import { WidgetUploads } from './widget-uploads.service'
import { WidgetController } from './widget.controller'
import { WidgetGateway } from './widget.gateway'

// The web widget's side of the api (TDD_10 §5.4): the public doors a script on the store's site calls,
// and the namespace where the replies reach the visitor. It needs the global modules of the app: the
// database and the event bus.
@Module({
  imports: [
    ChannelRegistryModule,
    ChannelsModule,
    TenancyModule,
    WebWidgetPlatformModule,
    WidgetDeliveryModule
  ],
  controllers: [WidgetController, WidgetSettingsController],
  providers: [
    WidgetSites,
    WidgetSettings,
    WidgetTokens,
    WidgetHistory,
    WidgetAway,
    WidgetUploads,
    WidgetDeliveryListener,
    WidgetCustomerTyping,
    WidgetGateway
  ]
})
export class WidgetModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The preflight is an OPTIONS the controller has no route for, so the paths are named
    consumer
      .apply(WidgetCorsMiddleware)
      .forRoutes(
        { path: ApiRoutes.widget.bootstrap, method: RequestMethod.OPTIONS },
        { path: ApiRoutes.widget.messages, method: RequestMethod.OPTIONS },
        { path: ApiRoutes.widget.upload, method: RequestMethod.OPTIONS }
      )
  }
}
