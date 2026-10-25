import { type DynamicModule, Global, Module } from '@nestjs/common'

import { PrismaService, type PrismaServiceOptions } from './prisma.service'
import { ProcessedWebhookEventsService } from './processed-webhook-events.service'

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
        ProcessedWebhookEventsService
      ],
      exports: [PrismaService, ProcessedWebhookEventsService]
    }
  }
}
