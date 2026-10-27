import { type DynamicModule, Global, Module } from '@nestjs/common'
import { EventEmitterModule } from '@nestjs/event-emitter'

import { DomainEvents } from './domain-events.service'
import { EVENTS_BRIDGE_OPTIONS, EventsBridge, type EventsBridgeOptions } from './events-bridge'

// In-process domain events. A listener is a method with @OnEvent(Events.X) on any provider. The
// module relies on the global DatabaseModule (PrismaService), LoggerModule (PinoLogger) and
// RedisModule of the app, which HttpPlatformModule imports around it.
@Global()
@Module({})
export class EventBusModule {
  static forRoot(options: EventsBridgeOptions): DynamicModule {
    return {
      module: EventBusModule,
      imports: [EventEmitterModule.forRoot()],
      providers: [
        { provide: EVENTS_BRIDGE_OPTIONS, useValue: options },
        EventsBridge,
        DomainEvents
      ],
      exports: [DomainEvents]
    }
  }
}
