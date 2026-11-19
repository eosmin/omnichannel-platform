import { type DynamicModule, Global, Module } from '@nestjs/common'

import { EventContext } from './event-context'
import { JobContext } from './job-context'
import { PrismaService, type PrismaServiceOptions } from './prisma.service'
import { ProcessedWebhookEventsService } from './processed-webhook-events.service'
import { WorkerLists } from './worker-lists'

@Global()
@Module({})
export class DatabaseModule {
  // The options come from the validated env of the app that imports this module. PrismaService
  // connects when the app starts and disconnects when it stops (its lifecycle hooks).
  static forRoot(options: PrismaServiceOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: PrismaService, useFactory: (): PrismaService => new PrismaService(options) },
        ProcessedWebhookEventsService,
        JobContext,
        EventContext,
        WorkerLists
      ],
      exports: [PrismaService, ProcessedWebhookEventsService, JobContext, EventContext, WorkerLists]
    }
  }
}
