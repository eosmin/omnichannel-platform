import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import {
  type DynamicModule,
  Inject,
  type ModuleMetadata,
  Injectable,
  Module,
  type OnModuleInit
} from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import type { Express, RequestHandler } from 'express'

import { InfraRoutes } from '@platform/core/api'
import { QueuesRegistry } from '@platform/core/queues-module'

import { bullBoardContentSecurityPolicy } from '../security-headers'

import { bullBoardAccess } from './bull-board-access.middleware'

export const BULL_BOARD_ADMIN_EMAILS = Symbol('BULL_BOARD_ADMIN_EMAILS')

// Mounted on Express when the module initialises: after Nest has registered its routes, but before
// its not-found handler. No route of Nest lives under /admin/queues (the global prefix is /api/v1),
// so nothing of Nest, the global guards included, stands in front of the board, and the access
// middleware is the only door.
@Injectable()
class BullBoardMount implements OnModuleInit {
  constructor(
    private readonly host: HttpAdapterHost,
    private readonly registry: QueuesRegistry,
    private readonly jwt: JwtService,
    @Inject(BULL_BOARD_ADMIN_EMAILS) private readonly adminEmails: readonly string[]
  ) {}

  onModuleInit(): void {
    const serverAdapter = new ExpressAdapter()
    serverAdapter.setBasePath(InfraRoutes.queues)
    createBullBoard({
      queues: this.registry.entries().map(([, queue]) => new BullMQAdapter(queue)),
      serverAdapter
    })
    const express = this.host.httpAdapter.getInstance<Express>() // The apps run on Express
    express.use(
      InfraRoutes.queues,
      bullBoardAccess({
        verify: token => this.jwt.verifyAsync(token),
        adminEmails: this.adminEmails
      }),
      bullBoardContentSecurityPolicy, // After the check: a refused request keeps the strict policy of the api
      serverAdapter.getRouter() as RequestHandler // Typed as any by the library
    )
  }
}

// Only imported when BULL_BOARD_ENABLED is on: with the flag off the route does not exist
@Module({})
export class BullBoardModule {
  // `imports` is where the queues come from (QueuesRegistry): the app's own queues module
  static forRoot(options: {
    adminEmails: readonly string[]
    imports: NonNullable<ModuleMetadata['imports']>
  }): DynamicModule {
    return {
      module: BullBoardModule,
      imports: options.imports,
      providers: [
        { provide: BULL_BOARD_ADMIN_EMAILS, useValue: options.adminEmails },
        BullBoardMount
      ]
    }
  }
}
