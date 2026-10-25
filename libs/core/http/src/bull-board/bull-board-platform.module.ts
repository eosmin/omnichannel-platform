import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

import { QueuesPlatformModule } from '../queues-platform.module'

import { BullBoardModule } from './bull-board.module'

// Bull Board for the api, from the validated env. The worker does not import it.
@Module({
  imports: env.BULL_BOARD_ENABLED
    ? [
        BullBoardModule.forRoot({
          adminEmails: env.BULL_BOARD_ADMIN_EMAILS,
          imports: [QueuesPlatformModule]
        })
      ]
    : []
})
export class BullBoardPlatformModule {}
