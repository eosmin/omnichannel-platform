import { Module } from '@nestjs/common'

import { QueuesPlatformModule } from '@platform/core/http'

import { RealtimeModule } from '../realtime/realtime.module'
import { TenancyModule } from '../tenancy'

import { NotificationPreferencesService } from './notification-preferences.service'
import { NotificationsEventsListener } from './notifications-events.listener'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'
import { PushSubscriptionsService } from './push-subscriptions.service'

// Needs the database module of the app. NotificationsService is exported for the modules that notify
// (conversations, media, exports).
@Module({
  imports: [TenancyModule, RealtimeModule, QueuesPlatformModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationsEventsListener,
    PushSubscriptionsService
  ],
  exports: [NotificationsService]
})
export class NotificationsModule {}
