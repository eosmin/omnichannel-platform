import { Module } from '@nestjs/common'

import { ChannelIds } from '@platform/core/domain'

import {
  DIRECT_TYPING_DELIVERIES,
  type DirectTypingDelivery
} from '../channel-registry/direct-typing'

import { WidgetDelivery } from './widget-delivery.service'
import { WidgetReadNotifier } from './widget-read-notifier.service'

// Alone so that the module of the sockets of the agents can reach the visitors' namespace without
// importing the whole widget module (which would tie the two together in a circle the day the widget
// needs something of the realtime). The gateway of the visitors attaches the namespace to this one
// instance.
@Module({
  providers: [
    WidgetDelivery,
    WidgetReadNotifier,
    {
      provide: DIRECT_TYPING_DELIVERIES,
      useFactory: (delivery: WidgetDelivery): DirectTypingDelivery[] => [
        {
          pluginId: ChannelIds.WEB_WIDGET,
          typing: (siteKey, visitorId, active) =>
            delivery.typingToVisitor(siteKey, visitorId, active)
        }
      ],
      inject: [WidgetDelivery]
    }
  ],
  exports: [WidgetDelivery, WidgetReadNotifier, DIRECT_TYPING_DELIVERIES]
})
export class WidgetDeliveryModule {}
