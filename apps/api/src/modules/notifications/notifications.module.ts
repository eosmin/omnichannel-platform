import { Module } from '@nestjs/common'

import { RealtimeModule } from '../realtime/realtime.module'
import { TenancyModule } from '../tenancy'

import { NotificationPreferencesService } from './notification-preferences.service'
import { NotificationsEventsListener } from './notifications-events.listener'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'

// Needs the database module of the app. NotificationsService is exported for the modules that notify
// (conversations, media, exports).
@Module({
  imports: [TenancyModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationPreferencesService, NotificationsEventsListener],
  exports: [NotificationsService]
})
export class NotificationsModule {}
