import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { MessagingWindowController } from './messaging-window.controller'
import { MESSAGING_WINDOW_POLICIES, NO_MESSAGING_WINDOWS } from './messaging-window.policy'
import { MessagingWindowService } from './messaging-window.service'

// Needs the database module of the app. MessagingWindowService is exported for the messages module
// and, later, for the outbound processor.
@Module({
  imports: [TenancyModule],
  controllers: [MessagingWindowController],
  providers: [
    MessagingWindowService,
    { provide: MESSAGING_WINDOW_POLICIES, useValue: NO_MESSAGING_WINDOWS }
  ],
  exports: [MessagingWindowService, MESSAGING_WINDOW_POLICIES]
})
export class MessagingWindowModule {}
