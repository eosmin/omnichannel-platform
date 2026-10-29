import { Module } from '@nestjs/common'

import { SocketLimits } from '@platform/core/realtime'

import { TenancyModule } from '../tenancy'

import { EventsGateway } from './events.gateway'
import { PresenceController } from './presence.controller'
import { PresenceService } from './presence.service'
import { RealtimeEventsListener } from './realtime-events.listener'
import { RealtimeService } from './realtime.service'
import { REALTIME_TIMING } from './realtime.types'
import { SocketAccessService } from './socket-access.service'

// The sockets of the agents and what they hear. It needs the global modules of the app: Redis,
// metrics, the database, the access tokens and the event bus.
@Module({
  imports: [TenancyModule],
  controllers: [PresenceController],
  providers: [
    EventsGateway,
    SocketAccessService,
    PresenceService,
    RealtimeService,
    RealtimeEventsListener,
    {
      provide: REALTIME_TIMING,
      useValue: {
        recheckMs: SocketLimits.RECHECK_SECONDS * 1000,
        silentMs: SocketLimits.SILENT_SECONDS * 1000
      }
    }
  ]
})
export class RealtimeModule {}
