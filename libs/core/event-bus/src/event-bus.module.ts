import { Global, Module } from '@nestjs/common'
import { EventEmitterModule } from '@nestjs/event-emitter'

import { DomainEvents } from './domain-events.service'

// In-process domain events. A listener is a method with @OnEvent(Events.X) on any provider. The
// module relies on the global DatabaseModule (PrismaService) and LoggerModule (PinoLogger) of the
// app, which HttpPlatformModule imports before it.
@Global()
@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [DomainEvents],
  exports: [DomainEvents]
})
export class EventBusModule {}
