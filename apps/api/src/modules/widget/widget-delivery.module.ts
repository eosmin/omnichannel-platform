import { Module } from '@nestjs/common'

import { WidgetDelivery } from './widget-delivery.service'
import { WidgetReadNotifier } from './widget-read-notifier.service'

// Alone so that the module of the sockets of the agents can reach the visitors' namespace without
// importing the whole widget module (which would tie the two together in a circle the day the widget
// needs something of the realtime). The gateway of the visitors attaches the namespace to this one
// instance.
@Module({
  providers: [WidgetDelivery, WidgetReadNotifier],
  exports: [WidgetDelivery, WidgetReadNotifier]
})
export class WidgetDeliveryModule {}
