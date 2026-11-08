import { Global, Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'

// The switch for sending several files in one message (`OUTBOUND_MULTI_FILE_ENABLED`), read from the validated
// env once, so that the routes that need it do not read the environment themselves.
export const MULTI_FILE_SEND_ENABLED = Symbol('MULTI_FILE_SEND_ENABLED')

// The switch for a text under each file of a message (`OUTBOUND_CAPTION_PER_FILE_ENABLED`)
export const CAPTION_PER_FILE_SEND_ENABLED = Symbol('CAPTION_PER_FILE_SEND_ENABLED')

@Global()
@Module({
  providers: [
    {
      provide: MULTI_FILE_SEND_ENABLED,
      useFactory: (): boolean => env.OUTBOUND_MULTI_FILE_ENABLED
    },
    {
      provide: CAPTION_PER_FILE_SEND_ENABLED,
      useFactory: (): boolean => env.OUTBOUND_CAPTION_PER_FILE_ENABLED
    }
  ],
  exports: [MULTI_FILE_SEND_ENABLED, CAPTION_PER_FILE_SEND_ENABLED]
})
export class OutboundFlagsPlatformModule {}
